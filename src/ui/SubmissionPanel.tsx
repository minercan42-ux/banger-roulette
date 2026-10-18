import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectSettings,
  selectViewerChoices,
  selectViewerPermissions,
  type PlayerView,
  type RoomView,
  type ViewerPermissions,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import {
  fetchMetadata,
  OEmbedError,
  type OEmbedMetadata,
} from '../player/metadata';
import { parseYouTubeLink } from '../player/links';
import {
  createPreview,
  isBlockingPreviewError,
  PreviewError,
  type PreviewPlayer,
  type PreviewStatus,
} from '../player/preview';
import type { Media } from '../shared/primitives';
import type { GameState } from '../shared/game';
import { useEmbedConsent } from './embed-consent';
import { formatDuration, genreName } from './format';
import { Button } from './pf/Button';
import { Field } from './pf/Field';
import { GenrePlate } from './pf/GenrePlate';
import { Hand } from './pf/Hand';
import { Panel, PanelTitle } from './pf/Panel';
import { SongCard } from './pf/SongCard';
import { PhaseTimer } from './pf/Stat';
import { useVolumeStore } from './volume-store';

/** Quiet time after the last link edit before the preview starts by itself. */
const AUTO_PREVIEW_DEBOUNCE_MS = 1000;
/** Quiet time after the last start-point edit before it is saved. */
const AUTOSAVE_DEBOUNCE_MS = 1000;
/** How long "Fertig" waits for a loading preview to prove the video plays. */
const FINISH_VALIDATION_TIMEOUT_MS = 15_000;

/** Current preview lifecycle, extended with "nothing loaded yet" and "loading". */
type PanelStatus = PreviewStatus | { type: 'idle' } | { type: 'loading' };

type ValidationResult =
  'playing' | 'error' | 'autoplayBlocked' | 'aborted' | 'timeout';

type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'skipped' }
  | { kind: 'rejected'; reason: string };

interface ValidationWaiter {
  generation: number;
  settle: (result: ValidationResult) => void;
}

/** Mutable panel internals that async callbacks and timers share. */
interface PanelRefs {
  generation: number;
  abort: AbortController | null;
  player: PreviewPlayer | null;
  host: HTMLDivElement | null;
  /** Set while the current generation's preview proved the video plays. */
  validated: { videoId: string; duration: number } | null;
  metadata: OEmbedMetadata | null;
  status: PanelStatus;
  /** The video the current preview generation was started for. */
  videoId: string | null;
  previewTimer: ReturnType<typeof setTimeout> | null;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  /** The newest in-flight submit; saves queue behind it. */
  saving: Promise<SaveOutcome> | null;
  waiters: Set<ValidationWaiter>;
  finishing: boolean;
  /** The reason a save was rejected during the current Fertig click. */
  finishRejection: string | null;
  /** Bumped when consent or write access is withdrawn; ends a running Fertig. */
  epoch: number;
  /**
   * Why the current Fertig click was cancelled; the first cause wins, so a
   * later write loss never reclassifies a consent-cancelled click.
   */
  cancelCause: 'consent' | 'writeLost' | null;
}

/** The latest rendered inputs, readable from timers and async callbacks. */
interface DraftRef {
  linkText: string;
  startSeconds: number;
  permissions: ViewerPermissions;
  consent: boolean;
}

function clearTimers(refs: PanelRefs) {
  if (refs.previewTimer !== null) {
    clearTimeout(refs.previewTimer);
    refs.previewTimer = null;
  }
  if (refs.autosaveTimer !== null) {
    clearTimeout(refs.autosaveTimer);
    refs.autosaveTimer = null;
  }
}

interface SubmissionPanelProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
  room: RoomView;
  roster: PlayerView[];
  self: PlayerView | undefined;
  permissions: ViewerPermissions;
}

interface Draft {
  link: string;
  startSeconds: number;
}

/** Start must stay a whole second inside the real video length (FR-23). */
function clampStart(value: number, durationSeconds: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.max(0, Math.round(value));
  if (durationSeconds > 0) {
    return Math.min(rounded, Math.max(0, Math.floor(durationSeconds) - 1));
  }
  return rounded;
}

function canonicalLink(videoId: string, startSeconds: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return startSeconds > 0 ? `${base}&t=${Math.floor(startSeconds)}s` : base;
}

function statusKey(status: PanelStatus): string {
  switch (status.type) {
    case 'idle':
      return 'submission.statusIdle';
    case 'loading':
      return 'submission.statusLoading';
    case 'ready':
      return 'submission.statusReady';
    case 'playing':
      return 'submission.statusPlaying';
    case 'autoplayBlocked':
      return 'submission.statusAutoplayBlocked';
    default:
      return 'submission.statusError';
  }
}

/**
 * FR-20..FR-26 submission UI. All network/player work is generation-guarded:
 * a metadata or preview result for a superseded link is discarded and can
 * neither flip the current status nor validate the link. A validated preview
 * submits its link by itself; "Fertig" submits whatever is pasted and
 * finishes only after the host holds it. Consent gates every YouTube load
 * (script, iframe, thumbnail); a reload shows the saved submission as text
 * only until the tab consents again.
 */
export function SubmissionPanel({
  session,
  state,
  viewerId,
  room,
  roster,
  self,
  permissions,
}: SubmissionPanelProps) {
  const { t, i18n } = useTranslation();
  const choices = selectViewerChoices(state, viewerId);
  const settings = selectSettings(state);
  const [initial] = useState<Draft>(() => {
    return choices.media
      ? {
          link: canonicalLink(
            choices.media.videoId,
            choices.media.startSeconds,
          ),
          startSeconds: choices.media.startSeconds,
        }
      : { link: '', startSeconds: 0 };
  });

  const [linkText, setLinkText] = useState(initial.link);
  const [startSeconds, setStartSeconds] = useState(initial.startSeconds);
  const { consented: consent } = useEmbedConsent();
  const [status, setStatus] = useState<PanelStatus>({ type: 'idle' });
  const [metadata, setMetadata] = useState<OEmbedMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);

  const stateRef = useRef<PanelRefs>({
    generation: 0,
    abort: null,
    player: null,
    host: null,
    validated: null,
    metadata: null,
    status: { type: 'idle' },
    videoId: null,
    previewTimer: null,
    autosaveTimer: null,
    saving: null,
    waiters: new Set(),
    finishing: false,
    finishRejection: null,
    epoch: 0,
    cancelCause: null,
  });
  // The latest draft for timers and async callbacks, which must never read a
  // stale render closure.
  const draftRef = useRef<DraftRef>({
    linkText: initial.link,
    startSeconds: initial.startSeconds,
    permissions,
    consent,
  });
  useLayoutEffect(() => {
    draftRef.current = { linkText, startSeconds, permissions, consent };
  });

  const teardown = useCallback(() => {
    const refs = stateRef.current;
    refs.generation += 1;
    clearTimers(refs);
    refs.abort?.abort();
    refs.abort = null;
    refs.player?.destroy();
    refs.player = null;
    refs.validated = null;
    refs.metadata = null;
    refs.status = { type: 'idle' };
    refs.videoId = null;
    for (const waiter of [...refs.waiters]) {
      waiter.settle('aborted');
    }
  }, [stateRef]);
  useEffect(() => teardown, [teardown]);

  // The top-bar volume control also drives the preview player.
  useEffect(
    () =>
      useVolumeStore.subscribe((next, previous) => {
        if (next.volume !== previous.volume) {
          stateRef.current.player?.setVolume(next.volume);
        }
        if (next.muted !== previous.muted) {
          stateRef.current.player?.setMuted(next.muted);
        }
      }),
    [],
  );

  // Revoking the consent (drawer) stops the preview player at once.
  useEffect(() => {
    if (!consent) {
      const refs = stateRef.current;
      refs.cancelCause ??= 'consent';
      refs.epoch += 1;
      teardown();
    }
  }, [consent, teardown]);
  const [seenConsent, setSeenConsent] = useState(consent);
  if (seenConsent !== consent) {
    setSeenConsent(consent);
    if (!consent) {
      setStatus({ type: 'idle' });
      setMetadata(null);
    }
  }

  // Snapshot callbacks cancel validation as soon as the write scope closes.
  useEffect(
    () =>
      session.subscribe(() => {
        const snapshot = session.getSnapshot();
        if (
          snapshot.state === null ||
          !selectViewerPermissions(
            snapshot.state,
            viewerId,
            snapshot.connectionId,
          ).canSubmit
        ) {
          stateRef.current.cancelCause ??= 'writeLost';
          stateRef.current.epoch += 1;
          teardown();
          setStatus({ type: 'idle' });
          setMetadata(null);
        }
      }),
    [session, viewerId, teardown],
  );

  const parsed = parseYouTubeLink(linkText);
  const isParticipant = self?.isParticipant ?? false;
  const editable = permissions.canSubmit && !busy;
  const duration = status.type === 'playing' ? status.durationSeconds : 0;
  const previewValid =
    parsed !== null &&
    status.type === 'playing' &&
    metadata?.videoId === parsed.videoId;
  const savedMedia = choices.media;

  function latestMedia(): Media | null {
    const snapshot = session.getSnapshot();
    return snapshot.state === null
      ? null
      : selectViewerChoices(snapshot.state, viewerId).media;
  }

  function publishStatus(next: PanelStatus) {
    stateRef.current.status = next;
    setStatus(next);
  }

  /** Drops the preview and its UI state, e.g. after a validation timeout. */
  function discardPreview() {
    teardown();
    setStatus({ type: 'idle' });
    setMetadata(null);
  }

  function settleWaiters(generation: number, result: ValidationResult) {
    for (const waiter of [...stateRef.current.waiters]) {
      if (waiter.generation === generation) {
        waiter.settle(result);
      }
    }
  }

  /**
   * Resolves once the preview of `generation` validates the link. A preview
   * that is already playing resolves at once; a stale generation is aborted.
   */
  function waitForValidation(
    generation: number,
    timeoutMs: number,
  ): Promise<ValidationResult> {
    const refs = stateRef.current;
    if (generation !== refs.generation) {
      return Promise.resolve('aborted');
    }
    if (refs.validated !== null) {
      return Promise.resolve('playing');
    }
    if (refs.status.type === 'error') {
      return Promise.resolve('error');
    }
    return new Promise<ValidationResult>((resolve) => {
      const waiter: ValidationWaiter = {
        generation,
        settle: (result) => {
          clearTimeout(timer);
          refs.waiters.delete(waiter);
          resolve(result);
        },
      };
      const timer = setTimeout(() => waiter.settle('timeout'), timeoutMs);
      refs.waiters.add(waiter);
    });
  }

  /** The media the validated preview stands for, or null while unvalidated. */
  function buildMedia(): Media | null {
    const refs = stateRef.current;
    const draft = draftRef.current;
    const link = parseYouTubeLink(draft.linkText);
    const { validated, metadata: meta } = refs;
    if (
      !draft.permissions.canSubmit ||
      link === null ||
      validated === null ||
      meta === null ||
      validated.videoId !== link.videoId ||
      meta.videoId !== link.videoId
    ) {
      return null;
    }
    return {
      videoId: link.videoId,
      title: meta.title,
      channel: meta.channel,
      thumbnail: meta.thumbnail,
      durationSeconds: validated.duration,
      startSeconds: clampStart(draft.startSeconds, validated.duration),
    };
  }

  /**
   * Submits the validated draft. Saves are serialized through `saving`, so a
   * later call sees the result of an earlier one and an unchanged draft sends
   * nothing.
   */
  function save(): Promise<SaveOutcome> {
    const refs = stateRef.current;
    const previous = refs.saving;
    const run = (async (): Promise<SaveOutcome> => {
      await previous;
      if (refs.finishing && refs.finishRejection !== null) {
        // This click already saw a rejected save of this draft: no retry.
        return { kind: 'rejected', reason: refs.finishRejection };
      }
      const media = buildMedia();
      if (media === null) {
        return { kind: 'skipped' };
      }
      const current = latestMedia();
      if (
        current !== null &&
        current.videoId === media.videoId &&
        current.startSeconds === media.startSeconds
      ) {
        return { kind: 'saved' };
      }
      const result = await session.dispatch({ type: 'SUBMIT_SONG', media });
      if (result.status === 'rejected') {
        if (refs.finishing) {
          refs.finishRejection = result.reason;
        }
        return { kind: 'rejected', reason: result.reason };
      }
      return { kind: 'saved' };
    })();
    refs.saving = run;
    void run.then(() => {
      if (refs.saving === run) {
        refs.saving = null;
      }
    });
    return run;
  }

  function autosave() {
    void save().then((outcome) => {
      if (outcome.kind === 'rejected') {
        setNoticeKey(`errors.${outcome.reason}`);
      }
    });
  }

  /** Start-point edits of a validated preview are saved after a quiet second. */
  function scheduleAutosave() {
    const refs = stateRef.current;
    if (refs.validated === null) {
      return;
    }
    if (refs.autosaveTimer !== null) {
      clearTimeout(refs.autosaveTimer);
    }
    refs.autosaveTimer = setTimeout(() => {
      refs.autosaveTimer = null;
      autosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function updateStart(next: (current: number) => number) {
    setStartSeconds(next);
    scheduleAutosave();
  }

  /**
   * Starts the preview of one link and returns its generation. Everything
   * async below is guarded by that generation: a result for a replaced link
   * can neither flip the status nor validate anything.
   */
  function startPreview(videoId: string, startAt: number): number | null {
    // Never load YouTube content without the current consent and write access.
    const allowed = draftRef.current;
    if (!allowed.consent || !allowed.permissions.canSubmit) {
      return null;
    }
    teardown();
    const refs = stateRef.current;
    const generation = (refs.generation += 1);
    const controller = new AbortController();
    refs.abort = controller;
    refs.videoId = videoId;
    publishStatus({ type: 'loading' });
    setMetadata(null);
    setNoticeKey(null);
    void runPreview(generation, videoId, startAt, controller.signal);
    return generation;
  }

  async function runPreview(
    generation: number,
    videoId: string,
    startAt: number,
    signal: AbortSignal,
  ) {
    const refs = stateRef.current;
    try {
      const meta = await fetchMetadata(videoId, signal);
      if (generation !== refs.generation) {
        return;
      }
      refs.metadata = meta;
      setMetadata(meta);
      const host = refs.host;
      if (host === null) {
        throw new Error('preview host missing');
      }
      const player = await createPreview(host, {
        videoId,
        startSeconds: startAt,
        volume: useVolumeStore.getState().volume,
        muted: useVolumeStore.getState().muted,
        title: t('submission.previewPlay'),
        signal,
        onStatus: (next) => {
          if (generation !== refs.generation) {
            return;
          }
          if (next.type === 'playing') {
            refs.validated = { videoId, duration: next.durationSeconds };
            setStartSeconds((current) =>
              clampStart(current, next.durationSeconds),
            );
          } else {
            refs.validated = null;
          }
          publishStatus(next);
          if (next.type === 'playing') {
            autosave();
            settleWaiters(generation, 'playing');
          } else if (next.type === 'error') {
            settleWaiters(generation, 'error');
          } else if (next.type === 'autoplayBlocked') {
            settleWaiters(generation, 'autoplayBlocked');
          }
        },
      });
      if (generation !== refs.generation) {
        player.destroy();
        return;
      }
      refs.player = player;
      // The control may have moved while the player was loading.
      player.setVolume(useVolumeStore.getState().volume);
      player.setMuted(useVolumeStore.getState().muted);
      if (refs.status.type !== 'error') {
        player.play();
      }
    } catch (error) {
      if (generation !== refs.generation) {
        return;
      }
      if (error instanceof PreviewError && error.code === 'ABORTED') {
        return;
      }
      publishStatus({ type: 'error', code: 0 });
      setNoticeKey(
        error instanceof OEmbedError
          ? 'submission.metadataFailed'
          : 'submission.previewFailed',
      );
      settleWaiters(generation, 'error');
    }
  }

  /** One timer per link edit: a valid link then previews and plays by itself. */
  function schedulePreview() {
    const refs = stateRef.current;
    if (refs.previewTimer !== null) {
      clearTimeout(refs.previewTimer);
    }
    refs.previewTimer = setTimeout(() => {
      refs.previewTimer = null;
      const draft = draftRef.current;
      const link = parseYouTubeLink(draft.linkText);
      if (link === null) {
        if (draft.linkText.trim() !== '') {
          setNoticeKey('submission.linkInvalid');
        }
        return;
      }
      if (!draft.consent || !draft.permissions.canSubmit) {
        return;
      }
      startPreview(link.videoId, draft.startSeconds);
    }, AUTO_PREVIEW_DEBOUNCE_MS);
  }

  async function remove() {
    if (!permissions.canSubmit || !choices.submitted || busy) {
      return;
    }
    clearTimers(stateRef.current);
    setBusy(true);
    setNoticeKey(null);
    await stateRef.current.saving;
    const result = await session.dispatch({ type: 'REMOVE_SUBMISSION' });
    setBusy(false);
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
      return;
    }
    teardown();
    setStatus({ type: 'idle' });
    setMetadata(null);
    setLinkText('');
    setStartSeconds(0);
  }

  /** True when the host already holds this link at this (clamped) start. */
  function savedMatches(videoId: string, startAt: number): boolean {
    const media = latestMedia();
    return (
      media !== null &&
      media.videoId === videoId &&
      clampStart(startAt, media.durationSeconds) === media.startSeconds
    );
  }

  /**
   * Makes sure the pasted link is validated and submitted. Returns true once
   * the host holds it; otherwise the reason is already shown to the player.
   */
  async function validateAndSave(
    videoId: string,
    startAt: number,
  ): Promise<boolean> {
    const refs = stateRef.current;
    const reusable =
      refs.videoId === videoId &&
      refs.status.type !== 'idle' &&
      refs.status.type !== 'error';
    const generation = reusable
      ? refs.generation
      : startPreview(videoId, startAt);
    if (generation === null) {
      setNoticeKey('submission.consentRequired');
      return false;
    }
    const result = await waitForValidation(
      generation,
      FINISH_VALIDATION_TIMEOUT_MS,
    );
    switch (result) {
      case 'playing': {
        // The save the PLAYING callback started is this click's save; a
        // rejection of it ends the click instead of being retried.
        const outcome = await save();
        if (outcome.kind === 'rejected') {
          setNoticeKey(`errors.${outcome.reason}`);
        }
        return outcome.kind === 'saved';
      }
      case 'autoplayBlocked':
        setNoticeKey('submission.autoplayBlocked');
        return false;
      case 'timeout':
        discardPreview();
        setNoticeKey('submission.previewFailed');
        return false;
      case 'error':
      case 'aborted':
        // An error is already on screen (preview-error or a notice).
        return false;
    }
  }

  /** True while this click's work is still wanted: not cancelled, still consented and writable. */
  function finishLive(epoch: number): boolean {
    const refs = stateRef.current;
    const draft = draftRef.current;
    return (
      refs.epoch === epoch &&
      refs.finishRejection === null &&
      draft.permissions.canFinishSubmission
    );
  }

  /** Resolves true once the host accepted FINISH_SUBMISSION. */
  async function submitAndFinish(): Promise<boolean> {
    const refs = stateRef.current;
    const epoch = refs.epoch;
    const first = draftRef.current;
    if (
      parseYouTubeLink(first.linkText) === null &&
      first.linkText.trim() !== ''
    ) {
      setNoticeKey('submission.linkInvalid');
      return false;
    }
    if (parseYouTubeLink(first.linkText) !== null) {
      await refs.saving;
      if (refs.finishRejection !== null) {
        setNoticeKey(`errors.${refs.finishRejection}`);
        return false;
      }
      // Everything below reads the draft as it is now, not as it was at the click.
      const draft = draftRef.current;
      const link = parseYouTubeLink(draft.linkText);
      if (!finishLive(epoch)) {
        return false;
      }
      if (link === null) {
        setNoticeKey('submission.linkInvalid');
        return false;
      }
      if (!savedMatches(link.videoId, draft.startSeconds)) {
        if (!draft.consent) {
          setNoticeKey('submission.consentRequired');
          return false;
        }
        if (!(await validateAndSave(link.videoId, draft.startSeconds))) {
          return false;
        }
        if (!finishLive(epoch)) {
          return false;
        }
      }
    }
    const result = await session.dispatch({ type: 'FINISH_SUBMISSION' });
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
      return false;
    }
    return true;
  }

  /**
   * "Fertig": submits the pasted link, waits for the host to hold it and only
   * then finishes. Whatever fails here leaves the player unfinished.
   */
  async function finish() {
    const refs = stateRef.current;
    if (refs.finishing || !permissions.canFinishSubmission || busy) {
      return;
    }
    refs.finishing = true;
    // Inside the click gesture, so a blocked preview may start audibly.
    if (
      refs.player !== null &&
      (refs.status.type === 'ready' || refs.status.type === 'autoplayBlocked')
    ) {
      refs.player.play();
    }
    clearTimers(refs);
    refs.finishRejection = null;
    refs.cancelCause = null;
    setBusy(true);
    setFinishing(true);
    setNoticeKey(null);
    try {
      const finished = await submitAndFinish();
      // A Fertig that stopped without a notice of its own, because write
      // access closed (pause, short disconnect), must not look like it
      // worked. Consent revocation and link edits keep ending silently: their
      // own hints explain them. No automatic retry; the draft stays.
      if (!finished && refs.cancelCause === 'writeLost') {
        setNoticeKey((current) => current ?? 'submission.finishInterrupted');
      }
    } finally {
      refs.finishing = false;
      setBusy(false);
      setFinishing(false);
    }
  }

  const participants = roster.filter((player) => player.isParticipant);
  const doneCount = participants.filter(
    (player) => player.submissionDone,
  ).length;

  // The hand shows the viewer's own song face up and one anonymous face-down
  // card per other finished player (AK-3: a count, never a name or an order).
  const othersDone = participants.filter(
    (player) => player.submissionDone && !player.isSelf,
  ).length;
  const ownCard = isParticipant ? savedMedia : null;

  return (
    <Panel as="section" data-testid="submission-panel" className="br-stack">
      {room.genre && (
        <GenrePlate
          calm
          kicker={t('genre.resultLabel')}
          name={genreName(room.genre, i18n.resolvedLanguage)}
        />
      )}
      <PanelTitle>{t('submission.heading')}</PanelTitle>
      <p className="br-read">{t('submission.intro')}</p>
      <div className="mt-3 flex">
        <PhaseTimer
          session={session}
          state={state}
          label={t('phase.timerLabel')}
          announce={(time) => t('phase.timerAnnounce', { time })}
        />
      </div>

      {!isParticipant && (
        <p
          data-testid="submission-spectator"
          role="status"
          className="br-notice"
        >
          {t('submission.spectatorOnly')}
        </p>
      )}

      <Panel
        well
        data-testid="submission-progress"
        data-count={doneCount}
        data-total={participants.length}
        className="br-stack"
      >
        <p className="br-read">
          {t('submission.progress', {
            done: doneCount,
            total: participants.length,
          })}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {participants.map((player) => (
            <li
              key={player.id}
              data-testid="submission-progress-player"
              data-player-id={player.id}
              data-done={player.submissionDone}
              className={`br-read ${
                player.submissionDone ? 'text-green' : 'text-cream-muted'
              }`}
            >
              {player.nickname}
              {player.isSelf ? ` (${t('lobby.you')})` : ''}:{' '}
              {player.submissionDone
                ? t('submission.progressDone')
                : t('submission.progressOpen')}
            </li>
          ))}
        </ul>
      </Panel>

      {(ownCard !== null || othersDone > 0) && (
        <Hand label={t('card.handSubmission')} data-testid="submission-hand">
          {ownCard !== null && (
            <SongCard
              data-testid="song-card"
              data-face="up"
              index={0}
              number={1}
              song={ownCard}
              showThumbnail={consent}
              tooltip={ownCard.title}
              label={t('card.ownSong', { title: ownCard.title })}
            />
          )}
          {Array.from({ length: othersDone }, (_, slot) => (
            <SongCard
              key={slot}
              data-testid="song-card"
              data-face="down"
              index={slot + 1}
              number={slot + 2}
              label={t('card.faceDown')}
            />
          ))}
        </Hand>
      )}

      {isParticipant && choices.submissionDone && (
        <p
          data-testid="submission-finished"
          role="status"
          className="br-notice"
        >
          {t('submission.finished')}
        </p>
      )}

      {isParticipant && !choices.submissionDone && (
        <div className="br-stack">
          {savedMedia && (
            <div data-testid="submission-saved" className="br-notice">
              <p className="font-semibold">{t('submission.savedHeading')}</p>
              <p data-testid="submission-saved-title">{savedMedia.title}</p>
              <p className="br-read">
                {savedMedia.channel} ·{' '}
                {t('submission.savedStart', {
                  start: formatDuration(savedMedia.startSeconds * 1000),
                })}
              </p>
            </div>
          )}

          <Field
            label={t('submission.linkLabel')}
            hint={t('submission.linkHint')}
            invalid={linkText.trim() !== '' && parsed === null}
            type="text"
            data-testid="song-link"
            value={linkText}
            disabled={!editable}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const nextLink = event.target.value;
              teardown();
              setStatus({ type: 'idle' });
              setMetadata(null);
              setNoticeKey(null);
              setLinkText(nextLink);
              setStartSeconds(parseYouTubeLink(nextLink)?.startSeconds ?? 0);
              schedulePreview();
            }}
          />

          {linkText.trim() !== '' && parsed === null && (
            <p
              data-testid="song-link-invalid"
              className="br-notice br-notice--error"
            >
              {t('submission.linkInvalid')}
            </p>
          )}

          {!consent && (
            <p data-testid="submission-consent-required" className="br-notice">
              {t('submission.consentRequired')}
            </p>
          )}

          <div className="br-row">
            {status.type === 'autoplayBlocked' && (
              <Button
                tone="blue"
                data-testid="preview-play"
                onClick={() => {
                  stateRef.current.player?.play();
                }}
                disabled={!editable}
              >
                {t('submission.previewPlay')}
              </Button>
            )}
            <span
              data-testid="preview-status"
              data-state={status.type}
              data-error-code={
                status.type === 'error' ? status.code : undefined
              }
              role="status"
              className="br-read"
            >
              {t(statusKey(status))}
            </span>
          </div>

          {status.type === 'error' && (
            <p
              data-testid="preview-error"
              className="br-notice br-notice--error"
            >
              {isBlockingPreviewError(status.code)
                ? t('submission.embeddingBlocked', { code: status.code })
                : t('submission.previewUnavailable', { code: status.code })}
            </p>
          )}
          {status.type === 'autoplayBlocked' && (
            <p className="br-notice">{t('submission.autoplayBlocked')}</p>
          )}

          {consent && metadata !== null && (
            <img
              data-testid="preview-thumbnail"
              src={metadata.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-24 w-40 rounded-md object-cover"
            />
          )}

          <div
            ref={(node) => {
              stateRef.current.host = node;
            }}
            data-testid="preview-host"
            className="overflow-hidden rounded-md bg-black/60"
            style={{ minHeight: '1px' }}
          />

          <div className="flex flex-wrap items-end gap-2">
            <Field
              label={t('submission.startLabel')}
              className="w-48 max-w-full flex-none"
              type="number"
              data-testid="start-seconds"
              min={0}
              step={1}
              value={startSeconds}
              disabled={!editable || !previewValid}
              onChange={(event) => {
                const next = Number(event.target.value);
                updateStart(() => clampStart(next, duration));
              }}
            />
            <Button
              tone="slate"
              size="sm"
              data-testid="set-start"
              onClick={() => {
                const player = stateRef.current.player;
                if (player === null) {
                  return;
                }
                const position = player.currentTime();
                updateStart(() => clampStart(position, duration));
              }}
              disabled={!editable || !previewValid}
            >
              {t('submission.setStart')}
            </Button>
            {(
              [
                ['start-minus-5', -5, 'submission.minus5'],
                ['start-minus-1', -1, 'submission.minus1'],
                ['start-plus-1', 1, 'submission.plus1'],
                ['start-plus-5', 5, 'submission.plus5'],
              ] as const
            ).map(([testId, delta, key]) => (
              <Button
                key={testId}
                tone="slate"
                size="sm"
                data-testid={testId}
                onClick={() =>
                  updateStart((current) =>
                    clampStart(current + delta, duration),
                  )
                }
                disabled={!editable || !previewValid}
              >
                {t(key)}
              </Button>
            ))}
          </div>

          {duration > 0 && (
            <p className="br-read">
              {t('submission.durationLabel', {
                duration: Math.floor(duration),
              })}
              {' · '}
              {t('submission.clipLabel', {
                clip: settings.clipSeconds,
              })}
            </p>
          )}

          {noticeKey &&
            !(
              noticeKey === 'submission.linkInvalid' &&
              linkText.trim() !== '' &&
              parsed === null
            ) && (
              <p
                data-testid="submission-notice"
                role="status"
                className="br-notice"
              >
                {t(noticeKey)}
              </p>
            )}

          {linkText.trim() === '' &&
            !choices.submitted &&
            permissions.canFinishSubmission && (
              <p data-testid="submission-finish-hint" className="br-read">
                {t('submission.finishSkipHint')}
              </p>
            )}

          <div className="br-row">
            <Button
              tone="red"
              data-testid="remove-submission"
              onClick={() => {
                void remove();
              }}
              disabled={!editable || !choices.submitted}
            >
              {t('submission.remove')}
            </Button>
            <Button
              tone="blue"
              data-testid="finish-submission"
              aria-busy={finishing}
              onClick={() => {
                void finish();
              }}
              disabled={!permissions.canFinishSubmission || busy}
            >
              {finishing ? t('submission.finishing') : t('submission.finish')}
            </Button>
          </div>

          {!permissions.canWrite && (
            <p className="br-notice">{t('lobby.readOnly')}</p>
          )}
        </div>
      )}
    </Panel>
  );
}
