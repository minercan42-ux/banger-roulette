import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Current preview lifecycle, extended with "nothing loaded yet" and "loading". */
type PanelStatus = PreviewStatus | { type: 'idle' } | { type: 'loading' };

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
 * neither flip the current status nor enable save. Consent gates every YouTube
 * load (script, iframe, thumbnail); a reload shows the saved submission as
 * text only until the tab consents again.
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
  const [noticeKey, setNoticeKey] = useState<string | null>(null);

  const stateRef = useRef({
    generation: 0,
    abort: null as AbortController | null,
    player: null as PreviewPlayer | null,
    host: null as HTMLDivElement | null,
    validated: null as { videoId: string; duration: number } | null,
  });

  const teardown = useCallback(() => {
    stateRef.current.generation += 1;
    stateRef.current.abort?.abort();
    stateRef.current.abort = null;
    stateRef.current.player?.destroy();
    stateRef.current.player = null;
    stateRef.current.validated = null;
  }, [stateRef]);

  useEffect(() => teardown, [teardown]);

  // Revoking the consent (drawer) stops the preview player at once.
  useEffect(() => {
    if (!consent) {
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
  const canSave = editable && previewValid;
  const savedMedia = choices.media;

  async function loadPreview() {
    if (parsed === null) {
      setNoticeKey('submission.linkInvalid');
      return;
    }
    if (!consent) {
      return;
    }
    if (!permissions.canSubmit || busy) {
      return;
    }
    teardown();
    const generation = (stateRef.current.generation += 1);
    const controller = new AbortController();
    stateRef.current.abort = controller;
    setStatus({ type: 'loading' });
    setMetadata(null);
    setNoticeKey(null);
    const signal = controller.signal;
    try {
      const meta = await fetchMetadata(parsed.videoId, signal);
      if (generation !== stateRef.current.generation) {
        return;
      }
      setMetadata(meta);
      const host = stateRef.current.host;
      if (host === null) {
        throw new Error('preview host missing');
      }
      const player = await createPreview(host, {
        videoId: parsed.videoId,
        startSeconds,
        title: t('submission.previewPlay'),
        signal,
        onStatus: (next) => {
          if (generation !== stateRef.current.generation) {
            return;
          }
          if (next.type === 'playing') {
            stateRef.current.validated = {
              videoId: parsed.videoId,
              duration: next.durationSeconds,
            };
            setStartSeconds((current) =>
              clampStart(current, next.durationSeconds),
            );
          } else {
            stateRef.current.validated = null;
          }
          setStatus(next);
        },
      });
      if (generation !== stateRef.current.generation) {
        player.destroy();
        return;
      }
      stateRef.current.player = player;
    } catch (error) {
      if (generation !== stateRef.current.generation) {
        return;
      }
      if (error instanceof PreviewError && error.code === 'ABORTED') {
        return;
      }
      setStatus({ type: 'error', code: 0 });
      setNoticeKey(
        error instanceof OEmbedError
          ? 'submission.metadataFailed'
          : 'submission.previewFailed',
      );
    }
  }

  async function save() {
    if (
      parsed === null ||
      metadata === null ||
      stateRef.current.validated === null ||
      stateRef.current.validated.videoId !== parsed.videoId ||
      status.type !== 'playing' ||
      stateRef.current.player?.videoId() !== parsed.videoId
    ) {
      setNoticeKey('submission.previewRequired');
      return;
    }
    if (!permissions.canSubmit || busy) {
      return;
    }
    setBusy(true);
    setNoticeKey(null);
    const result = await session.dispatch({
      type: 'SUBMIT_SONG',
      media: {
        videoId: parsed.videoId,
        title: metadata.title,
        channel: metadata.channel,
        thumbnail: metadata.thumbnail,
        durationSeconds: stateRef.current.validated.duration,
        startSeconds: clampStart(
          startSeconds,
          stateRef.current.validated.duration,
        ),
      },
    });
    setBusy(false);
    setNoticeKey(
      result.status === 'rejected'
        ? `errors.${result.reason}`
        : 'submission.savedNotice',
    );
  }

  async function remove() {
    if (!permissions.canSubmit || !choices.submitted || busy) {
      return;
    }
    setBusy(true);
    setNoticeKey(null);
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

  async function finish() {
    if (!permissions.canFinishSubmission || busy) {
      return;
    }
    setBusy(true);
    setNoticeKey(null);
    const result = await session.dispatch({ type: 'FINISH_SUBMISSION' });
    setBusy(false);
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
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
            <Button
              tone="blue"
              data-testid="load-preview"
              onClick={() => {
                void loadPreview();
              }}
              disabled={!editable || parsed === null || !consent}
            >
              {t('submission.loadPreview')}
            </Button>
            <Button
              tone="slate"
              data-testid="preview-play"
              onClick={() => {
                stateRef.current.player?.play();
              }}
              disabled={
                !editable ||
                !(status.type === 'ready' || status.type === 'autoplayBlocked')
              }
            >
              {t('submission.previewPlay')}
            </Button>
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
                setStartSeconds(clampStart(next, duration));
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
                setStartSeconds(clampStart(player.currentTime(), duration));
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
                  setStartSeconds((current) =>
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

          {noticeKey && (
            <p
              data-testid="submission-notice"
              role="status"
              className="br-notice"
            >
              {t(noticeKey)}
            </p>
          )}

          <div className="br-row">
            <Button
              data-testid="save-submission"
              onClick={() => {
                void save();
              }}
              disabled={!canSave}
            >
              {t('submission.save')}
            </Button>
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
              onClick={() => {
                void finish();
              }}
              disabled={!permissions.canFinishSubmission || busy}
            >
              {t('submission.finish')}
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
