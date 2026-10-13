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
import { formatDuration, genreName } from './format';

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
  const [consent, setConsent] = useState(false);
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
      setNoticeKey('submission.consentRequired');
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

  return (
    <section
      data-testid="submission-panel"
      className="rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('submission.heading')}
        </h2>
        {room.genre && (
          <span className="text-xs text-cream-100/60">
            {t('phase.genreLabel', {
              genre: genreName(room.genre, i18n.resolvedLanguage),
            })}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-cream-100/70">{t('submission.intro')}</p>

      {!isParticipant && (
        <p
          data-testid="submission-spectator"
          role="status"
          className="mt-3 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100"
        >
          {t('submission.spectatorOnly')}
        </p>
      )}

      <div
        data-testid="submission-progress"
        data-count={doneCount}
        data-total={participants.length}
        className="mt-4 rounded-lg border border-gold-400/20 bg-felt-900/50 px-3 py-2"
      >
        <p className="text-sm text-cream-100/80">
          {t('submission.progress', {
            done: doneCount,
            total: participants.length,
          })}
        </p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {participants.map((player) => (
            <li
              key={player.id}
              data-testid="submission-progress-player"
              data-player-id={player.id}
              data-done={player.submissionDone}
              className={
                player.submissionDone ? 'text-emerald-200' : 'text-cream-100/60'
              }
            >
              {player.nickname}
              {player.isSelf ? ` (${t('lobby.you')})` : ''}:{' '}
              {player.submissionDone
                ? t('submission.progressDone')
                : t('submission.progressOpen')}
            </li>
          ))}
        </ul>
      </div>

      {isParticipant && choices.submissionDone && (
        <p
          data-testid="submission-finished"
          role="status"
          className="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100"
        >
          {t('submission.finished')}
        </p>
      )}

      {isParticipant && !choices.submissionDone && (
        <div className="mt-4 space-y-3">
          {savedMedia && (
            <div
              data-testid="submission-saved"
              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100"
            >
              <p className="font-semibold">{t('submission.savedHeading')}</p>
              <p data-testid="submission-saved-title">{savedMedia.title}</p>
              <p className="text-xs text-emerald-100/80">
                {savedMedia.channel} ·{' '}
                {t('submission.savedStart', {
                  start: formatDuration(savedMedia.startSeconds * 1000),
                })}
              </p>
            </div>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-cream-100/80">
              {t('submission.linkLabel')}
            </span>
            <input
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
              className="rounded-md border border-gold-400/40 bg-felt-950 px-3 py-2 text-cream-100 disabled:opacity-50"
            />
            <span className="text-xs text-cream-100/50">
              {t('submission.linkHint')}
            </span>
          </label>

          {linkText.trim() !== '' && parsed === null && (
            <p
              data-testid="song-link-invalid"
              className="text-xs text-rose-300"
            >
              {t('submission.linkInvalid')}
            </p>
          )}

          <label className="flex items-start gap-2 text-sm text-cream-100/80">
            <input
              type="checkbox"
              data-testid="youtube-consent"
              checked={consent}
              disabled={!editable}
              onChange={(event) => {
                const accepted = event.target.checked;
                setConsent(accepted);
                if (!accepted) {
                  teardown();
                  setStatus({ type: 'idle' });
                  setMetadata(null);
                }
              }}
              className="mt-1"
            />
            <span>{t('submission.consentLabel')}</span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="load-preview"
              onClick={() => {
                void loadPreview();
              }}
              disabled={!editable || parsed === null}
              className="rounded-md border border-gold-400/50 bg-gold-500/20 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.loadPreview')}
            </button>
            <button
              type="button"
              data-testid="preview-play"
              onClick={() => {
                stateRef.current.player?.play();
              }}
              disabled={
                !editable ||
                !(status.type === 'ready' || status.type === 'autoplayBlocked')
              }
              className="rounded-md border border-gold-400/50 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.previewPlay')}
            </button>
            <span
              data-testid="preview-status"
              data-state={status.type}
              data-error-code={
                status.type === 'error' ? status.code : undefined
              }
              role="status"
              className="text-xs text-cream-100/70"
            >
              {t(statusKey(status))}
            </span>
          </div>

          {status.type === 'error' && (
            <p data-testid="preview-error" className="text-xs text-rose-300">
              {isBlockingPreviewError(status.code)
                ? t('submission.embeddingBlocked', { code: status.code })
                : t('submission.previewUnavailable', { code: status.code })}
            </p>
          )}
          {status.type === 'autoplayBlocked' && (
            <p className="text-xs text-amber-200">
              {t('submission.autoplayBlocked')}
            </p>
          )}

          {consent && metadata !== null && (
            <img
              data-testid="preview-thumbnail"
              src={metadata.thumbnail}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-24 w-40 rounded-md border border-gold-400/20 object-cover"
            />
          )}

          <div
            ref={(node) => {
              stateRef.current.host = node;
            }}
            data-testid="preview-host"
            className="overflow-hidden rounded-lg border border-gold-400/20 bg-black/60"
            style={{ minHeight: '1px' }}
          />

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cream-100/80">
                {t('submission.startLabel')}
              </span>
              <input
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
                className="w-24 rounded-md border border-gold-400/40 bg-felt-950 px-2 py-2 text-cream-100 disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              data-testid="set-start"
              onClick={() => {
                const player = stateRef.current.player;
                if (player === null) {
                  return;
                }
                setStartSeconds(clampStart(player.currentTime(), duration));
              }}
              disabled={!editable || !previewValid}
              className="rounded-md border border-gold-400/50 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.setStart')}
            </button>
            {(
              [
                ['start-minus-5', -5, 'submission.minus5'],
                ['start-minus-1', -1, 'submission.minus1'],
                ['start-plus-1', 1, 'submission.plus1'],
                ['start-plus-5', 5, 'submission.plus5'],
              ] as const
            ).map(([testId, delta, key]) => (
              <button
                key={testId}
                type="button"
                data-testid={testId}
                onClick={() =>
                  setStartSeconds((current) =>
                    clampStart(current + delta, duration),
                  )
                }
                disabled={!editable || !previewValid}
                className="rounded-md border border-gold-400/40 px-2 py-2 text-xs text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t(key)}
              </button>
            ))}
          </div>

          {duration > 0 && (
            <p className="text-xs text-cream-100/60">
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
              className="rounded-lg border border-gold-400/25 bg-felt-900/60 px-3 py-2 text-xs text-cream-100/80"
            >
              {t(noticeKey)}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="save-submission"
              onClick={() => {
                void save();
              }}
              disabled={!canSave}
              className="rounded-md border border-emerald-400/50 bg-emerald-500/20 px-4 py-2 text-sm text-cream-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.save')}
            </button>
            <button
              type="button"
              data-testid="remove-submission"
              onClick={() => {
                void remove();
              }}
              disabled={!editable || !choices.submitted}
              className="rounded-md border border-rose-400/40 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.remove')}
            </button>
            <button
              type="button"
              data-testid="finish-submission"
              onClick={() => {
                void finish();
              }}
              disabled={!permissions.canFinishSubmission || busy}
              className="rounded-md border border-gold-400/50 px-4 py-2 text-sm text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('submission.finish')}
            </button>
          </div>

          {!permissions.canWrite && (
            <p className="text-xs text-amber-200">{t('lobby.readOnly')}</p>
          )}
        </div>
      )}
    </section>
  );
}
