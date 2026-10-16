import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectPlayback,
  selectSongs,
  selectViewerChoices,
  selectViewerPermissions,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { PlaybackPlan, PlaybackStatus } from '../player/playback';
import type { GameState } from '../shared/game';
import { useEmbedConsent } from './embed-consent';
import { LinkedAnimation, prerollElapsedMs } from './LinkedAnimation';
import { usePlaybackControllerContext } from './playback-controller';
import { Button } from './pf/Button';
import { Hand } from './pf/Hand';
import { Panel, PanelTitle } from './pf/Panel';
import { SongCard } from './pf/SongCard';
import { Progress } from './pf/Progress';
import { TimerStat } from './pf/Stat';
import { useSessionNow } from './use-session-now';

interface PlaybackPhaseProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
  viewerConnectionId: string | null;
}

const DEFAULT_VOLUME = 70;
const PROGRESS_FRAME_MS = 200;

/** Human label for every controller status plus the pre-consent "idle". */
function statusKey(status: PlaybackStatus | 'idle'): string {
  switch (status) {
    case 'idle':
      return 'playback.statusIdle';
    case 'loading':
      return 'playback.statusLoading';
    case 'cued':
      return 'playback.statusCued';
    case 'scheduled':
      return 'playback.statusScheduled';
    case 'playing':
      return 'playback.statusPlaying';
    case 'buffering':
      return 'playback.statusBuffering';
    case 'blocked':
      return 'playback.statusBlocked';
    case 'paused':
      return 'playback.statusPaused';
    case 'skipped':
      return 'playback.statusSkipped';
    case 'ended':
      return 'playback.statusEnded';
  }
}

/**
 * FR-30..FR-35 playback view. Timing is absolute server time: the engine hands
 * a plan of `startAt`/`deadlineAt` (shifted together on resume) and the player
 * owns the actual synchronisation. This view only renders state: it never
 * invents a start, never treats an AudioContext resume as autoplay proof and
 * gates every YouTube load (script, iframe, thumbnail) behind the shared
 * per-tab consent. The controller persists across songs for pre-cue and is
 * destroyed on phase exit.
 */
export function PlaybackPhase({
  session,
  state,
  viewerId,
  viewerConnectionId,
}: PlaybackPhaseProps) {
  const { t } = useTranslation();
  const view = selectPlayback(state, viewerId, viewerConnectionId);
  const songs = selectSongs(state, viewerId);
  const choices = selectViewerChoices(state, viewerId);
  const permissions = selectViewerPermissions(
    state,
    viewerId,
    viewerConnectionId,
  );
  const { consented, setConsent } = useEmbedConsent();
  const now = useSessionNow(session, true, PROGRESS_FRAME_MS);

  const aliveRef = useRef(true);
  const videoIdRef = useRef<string | null>(null);
  const planRef = useRef<PlaybackPlan | null>(null);

  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);

  // The controller is owned by RoomView (M4 AK-7 pre-warm): it is created
  // during SUBMISSION and reused into PLAYBACK. This view only drives it.
  const controller = usePlaybackControllerContext();
  const volume = controller?.volume ?? DEFAULT_VOLUME;
  const muted = controller?.muted ?? false;
  const diagnostics = controller?.diagnostics ?? null;

  const planKey =
    view === null
      ? ''
      : `${view.song.videoId}|${view.song.startSeconds}|${view.song.clipSeconds}|${view.startAt}|${view.deadlineAt}|${view.pausedAt}`;
  useEffect(() => {
    planRef.current =
      view === null
        ? null
        : {
            videoId: view.song.videoId,
            startSeconds: view.song.startSeconds,
            clipSeconds: view.song.clipSeconds,
            startAt: view.startAt,
            deadlineAt: view.deadlineAt,
            pausedAt: view.pausedAt,
          };
    videoIdRef.current = view?.song.videoId ?? null;
  }, [view]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Push the current plan into the lifted controller; the room creates it
  // plan-less and it adopts this plan on its first update.
  useEffect(() => {
    const current = planRef.current;
    if (!consented || current === null || controller === null) {
      return;
    }
    controller.update(current);
  }, [consented, planKey, controller]);

  // Cards flip one frame after they appear, so a new song's card turns over
  // instead of showing up already face up (a 1 ms change under reduced motion).
  const currentIndex = view?.index ?? -1;
  const [flippedCount, setFlippedCount] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setFlippedCount(currentIndex + 1),
    );
    return () => cancelAnimationFrame(frame);
  }, [currentIndex]);

  if (view === null) {
    return null;
  }

  // Pause freezes wall time, so the preroll window and elapsed progress must
  // read the pause instant instead of a live clock that keeps running.
  const frozenNow = view.pausedAt ?? now;
  const totalMs = Math.max(1, view.deadlineAt - view.startAt);
  const elapsedMs = Math.min(totalMs, Math.max(0, frozenNow - view.startAt));
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const preroll = view.index === 0 && frozenNow < view.startAt;
  const status: PlaybackStatus | 'idle' = consented
    ? (diagnostics?.status ?? 'loading')
    : 'idle';
  const debug =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('debug') === '1';
  const clock = session.getSnapshot().clock;
  const errorCode = diagnostics?.errorCode ?? null;
  const observedStart = diagnostics?.observedStartAt ?? null;
  const startSkew = diagnostics?.startSkewMs ?? null;
  const drift = diagnostics?.driftMs ?? null;
  const ownersVisible = view.song.ownersVisible && view.song.owners.length > 0;
  const rttLabel = clock.rttMs === null ? '–' : `${Math.round(clock.rttMs)} ms`;
  const boundTab = choices.isParticipant && !permissions.canWrite;

  async function flagGenreFail() {
    if (view === null || !view.canFlag || flagBusy) {
      return;
    }
    const videoId = view.song.videoId;
    setFlagBusy(true);
    setNoticeKey(null);
    const result = await session.dispatch({
      type: 'SET_GENRE_FAIL',
      videoId,
      flagged: true,
    });
    if (!aliveRef.current) {
      return;
    }
    setFlagBusy(false);
    // A stale result for a song that already moved on must not touch the UI.
    if (videoIdRef.current !== videoId) {
      return;
    }
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
    }
  }

  return (
    <Panel
      as="section"
      data-testid="playback-phase"
      data-preroll={preroll}
      data-index={view.index}
      data-song-count={view.songCount}
      data-consented={consented}
      data-status={status}
      className="br-stack"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle>{t('playback.heading')}</PanelTitle>
        <span
          data-testid="playback-song-count"
          data-index={view.index}
          data-count={view.songCount}
          className="br-label"
        >
          {t('playback.songCount', {
            index: view.index + 1,
            count: view.songCount,
          })}
        </span>
      </div>

      {preroll && (
        <div className="br-stack">
          <p data-testid="playback-preroll" className="br-read">
            {t('later.playbackPreroll')}
          </p>
          <LinkedAnimation
            songs={songs}
            showEmptyMarker
            elapsedMs={prerollElapsedMs(view, now)}
            paused={view.pausedAt !== null}
          />
        </div>
      )}

      {!choices.isParticipant && (
        <p data-testid="playback-spectator" role="status" className="br-notice">
          {t('playback.spectator')}
        </p>
      )}

      {boundTab && (
        <p data-testid="playback-bound-tab" role="status" className="br-notice">
          {t('playback.boundTab')}
        </p>
      )}

      {/* Songs up to the playing one are face up (the viewer has heard them);
          the rest stay face down, so no title is shown ahead of its turn. */}
      <Hand label={t('card.handPlayback')} data-testid="playback-hand">
        {songs.map((song, position) =>
          position <= view.index ? (
            <SongCard
              key={position}
              data-testid="song-card"
              data-face="up"
              data-current={position === view.index}
              index={position}
              number={position + 1}
              song={song}
              flipped={position < flippedCount}
              showThumbnail={consented}
              thumbnailTestId={
                position === view.index ? 'playback-thumbnail' : undefined
              }
              tooltip={song.title}
              label={t('card.faceUp', {
                number: position + 1,
                title: song.title,
              })}
            />
          ) : (
            <SongCard
              key={position}
              data-testid="song-card"
              data-face="down"
              index={position}
              number={position + 1}
              label={t('card.faceDown')}
            />
          ),
        )}
      </Hand>

      <div className="br-stack br-playing">
        <p data-testid="playback-title" className="br-playing__title">
          {view.song.title}
        </p>
        <p data-testid="playback-channel" className="br-read">
          {view.song.channel}
        </p>
        {ownersVisible ? (
          <ul
            data-testid="playback-owners"
            data-visible="true"
            className="br-read flex flex-wrap gap-x-3 text-gold"
          >
            {view.song.owners.map((owner) => (
              <li
                key={owner.id}
                data-testid="playback-owner"
                data-owner-id={owner.id}
              >
                {owner.nickname}
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="playback-anonymous-note" className="br-read">
            {t('playback.ownersHidden')}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <TimerStat
          session={session}
          deadlineAt={view.deadlineAt}
          pausedAt={view.pausedAt}
          label={t('playback.timeLabel')}
          data-testid="playback-timer"
        />
        <Progress
          data-testid="playback-progress"
          aria-label={t('playback.progressLabel')}
          value={elapsedMs}
          max={totalMs}
          data-elapsed-ms={Math.round(elapsedMs)}
          data-total-ms={Math.round(totalMs)}
          data-remaining-ms={Math.round(remainingMs)}
          className="min-w-40 flex-1"
        />
      </div>

      <div className="br-stack">
        {!consented && (
          <p data-testid="playback-consent-required" className="br-read">
            {t('playback.consentRequired')}
          </p>
        )}
        <label className="br-check">
          <input
            type="checkbox"
            data-testid="playback-consent"
            checked={consented}
            onChange={(event) => {
              setConsent(event.target.checked);
            }}
            className="br-check__input"
          />
          <span>{t('playback.consentLabel')}</span>
        </label>
      </div>

      {consented && (
        <div className="br-stack">
          <p
            data-testid="playback-status"
            data-state={status}
            data-error-code={errorCode ?? undefined}
            role="status"
            className="br-read"
          >
            {t(statusKey(status))}
          </p>

          {status === 'buffering' && (
            <p data-testid="playback-buffering" className="br-notice">
              {t('playback.bufferingHint')}
            </p>
          )}
          {status === 'skipped' && (
            <p data-testid="playback-skipped" className="br-notice">
              {t('playback.skippedHint')}
            </p>
          )}
          {status === 'blocked' && (
            <div className="br-stack">
              <p data-testid="playback-blocked" className="br-notice">
                {t('playback.blockedHint')}
              </p>
              <div>
                <Button
                  tone="blue"
                  size="sm"
                  data-testid="playback-recover"
                  onClick={() => {
                    controller?.recover();
                  }}
                >
                  {t('playback.recover')}
                </Button>
              </div>
            </div>
          )}
          {errorCode !== null && (
            <p
              data-testid="playback-error"
              className="br-notice br-notice--error"
            >
              {t('playback.errorHint', { code: errorCode })}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <label className="br-check">
              <span>{t('playback.volumeLabel')}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                data-testid="playback-volume"
                data-value={volume}
                value={volume}
                onChange={(event) => {
                  controller?.setVolume(Number(event.target.value));
                }}
              />
            </label>
            <label className="br-check">
              <input
                type="checkbox"
                data-testid="playback-mute"
                data-muted={muted}
                checked={muted}
                onChange={(event) => {
                  controller?.setMuted(event.target.checked);
                }}
                className="br-check__input"
              />
              <span>{t('playback.muteLabel')}</span>
            </label>
          </div>

          <div className="br-row">
            <Button
              tone="red"
              size="sm"
              data-testid="playback-flag"
              data-flagged={view.flaggedByViewer}
              disabled={!view.canFlag || flagBusy}
              onClick={() => {
                void flagGenreFail();
              }}
            >
              {t('playback.flag')}
            </Button>
            {view.flaggedByViewer && (
              <span
                data-testid="playback-flag-note"
                className="br-read text-red-text"
              >
                {t('playback.flagged')}
              </span>
            )}
          </div>

          {noticeKey && (
            <p
              data-testid="playback-notice"
              role="status"
              className="br-notice"
            >
              {t(noticeKey)}
            </p>
          )}
        </div>
      )}

      {debug && (
        <Panel
          well
          as="dl"
          data-testid="playback-debug"
          data-offset-ms={clock.offsetMs}
          data-rtt-ms={clock.rttMs ?? ''}
          data-synchronized={clock.synchronized}
          data-planned-start={view.startAt}
          data-planned-deadline={view.deadlineAt}
          data-observed-start={observedStart ?? ''}
          data-start-skew-ms={startSkew ?? ''}
          data-drift-ms={drift ?? ''}
          data-status={status}
          className="br-read grid grid-cols-2 gap-x-4 gap-y-1"
        >
          <dt>{t('playback.debugOffset')}</dt>
          <dd>{`${Math.round(clock.offsetMs)} ms`}</dd>
          <dt>{t('playback.debugRtt')}</dt>
          <dd>{rttLabel}</dd>
          <dt>{t('playback.debugSynchronized')}</dt>
          <dd>{clock.synchronized ? t('common.yes') : t('common.no')}</dd>
          <dt>{t('playback.debugPlannedStart')}</dt>
          <dd>{Math.round(view.startAt)}</dd>
          <dt>{t('playback.debugPlannedDeadline')}</dt>
          <dd>{Math.round(view.deadlineAt)}</dd>
          <dt>{t('playback.debugObservedStart')}</dt>
          <dd>{observedStart === null ? '–' : Math.round(observedStart)}</dd>
          <dt>{t('playback.debugStartSkew')}</dt>
          <dd>{startSkew === null ? '–' : `${Math.round(startSkew)} ms`}</dd>
          <dt>{t('playback.debugDrift')}</dt>
          <dd>{drift === null ? '–' : `${Math.round(drift)} ms`}</dd>
          <dt>{t('playback.debugStatus')}</dt>
          <dd>{t(statusKey(status))}</dd>
        </Panel>
      )}
    </Panel>
  );
}
