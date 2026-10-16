import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectLobbyReadiness,
  selectPlayback,
  selectRoom,
  selectViewerPermissions,
  type PlayerView,
} from '../engine/selectors';
import type { GameSession, SessionSnapshot } from '../net/session';
import type { GameState } from '../shared/game';
import { useEmbedConsent } from './embed-consent';
import { FinalPhase } from './FinalPhase';
import { GenreSpin } from './GenreSpin';
import { HostControls } from './HostControls';
import { PhaseAnnouncer, PhaseNotices, PhaseSummary } from './PhaseSummary';
import { Button } from './pf/Button';
import { Chip } from './pf/Chip';
import { Field } from './pf/Field';
import { Panel, PanelTitle } from './pf/Panel';
import { TableLayout } from './pf/TableLayout';
import { PlaybackPhase } from './PlaybackPhase';
import {
  PlaybackControllerContext,
  usePlaybackController,
} from './playback-controller';
import { RevealPhase } from './RevealPhase';
import { RosterList } from './RosterList';
import { SettingsForm } from './SettingsForm';
import { SfxDirector } from './SfxDirector';
import { SoundControl } from './SoundControl';
import { SubmissionPanel } from './SubmissionPanel';
import { useSoundUnlock } from './useSoundUnlock';

interface RoomViewProps {
  session: GameSession;
  snapshot: SessionSnapshot;
  state: GameState;
  roster: PlayerView[];
  onLeave: () => void;
  /** Shell chrome the table frame places: wordmark, SFX/language, banners, privacy. */
  brand: ReactNode;
  controls: ReactNode;
  notices: ReactNode;
  footer: ReactNode;
}

export function RoomView({
  session,
  snapshot,
  state,
  roster,
  onLeave,
  brand,
  controls,
  notices,
  footer,
}: RoomViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const viewerId = snapshot.clientId;
  const self = roster.find((player) => player.isSelf);
  const permissions = selectViewerPermissions(
    state,
    viewerId,
    snapshot.connectionId,
  );
  const room = selectRoom(state);
  const readiness = selectLobbyReadiness(state);
  const shareUrl = `${window.location.origin}/r/${room.roomCode}`;

  // M4 AK-7: one playback controller for the tab, pre-warmed during SUBMISSION
  // and reused into PLAYBACK. It exists only while the viewer consented and the
  // phase is SUBMISSION or PLAYBACK; any other phase (or withdrawal) destroys
  // it. The plan is unknown during SUBMISSION, so only the player is warmed.
  const { consented } = useEmbedConsent();
  const playbackView = selectPlayback(state, viewerId, snapshot.connectionId);
  const playbackHostRef = useRef<HTMLDivElement | null>(null);
  const playback = usePlaybackController({
    session,
    active:
      consented && (room.phase === 'SUBMISSION' || room.phase === 'PLAYBACK'),
    title: playbackView?.song.title ?? t('playback.heading'),
    hostRef: playbackHostRef,
  });

  // FR-07: the unlock state and AudioContext belong to the room view, not to
  // the SoundControl that the layout moves between the stage and the drawer.
  const canWriteSelf = self !== undefined && permissions.canWrite;
  const sound = useSoundUnlock(
    session,
    canWriteSelf,
    self?.soundUnlocked ?? false,
  );

  async function copyLink() {
    try {
      if (!navigator.clipboard) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  async function kick(playerId: string) {
    setErrorKey(null);
    const result = await session.dispatch({ type: 'KICK', playerId });
    if (result.status === 'rejected') {
      setErrorKey(`errors.${result.reason}`);
    }
  }

  const lobby = room.phase === 'LOBBY';
  const soundControl = <SoundControl sound={sound} canWrite={canWriteSelf} />;

  const stage = (
    <div data-testid="room-view" data-phase={room.phase} className="space-y-4">
      {/* SPEC §6: one effect director for the room, driven by the shared state
          instead of the phase components. */}
      <SfxDirector session={session} state={state} />
      {/* SPEC §6: the phase live region is mounted for the whole room lifecycle
          (LOBBY included) so the lobby boundary is announced too. */}
      <PhaseAnnouncer room={room} />
      {lobby ? (
        <PanelTitle as="h1" className="flex items-center gap-2">
          <Chip tone="gold" />
          {t('lobby.heading')}
        </PanelTitle>
      ) : (
        <h1 className="sr-only">{t('lobby.heading')}</h1>
      )}

      {self && !permissions.canWrite && (
        <p
          data-testid="read-only-indicator"
          role="status"
          className="br-notice"
        >
          {t('lobby.readOnly')}
        </p>
      )}

      {errorKey && (
        <p
          data-testid="action-error"
          role="alert"
          className="br-notice br-notice--error"
        >
          {t(errorKey)}
        </p>
      )}

      {!self && (
        <p data-testid="player-pending" role="status" className="br-notice">
          {t('lobby.waitingForHost')}
        </p>
      )}

      {lobby && (
        <p data-testid="lobby-start-hint" className="br-notice">
          {t('lobby.startHint')}
        </p>
      )}

      <PlaybackControllerContext.Provider value={playback}>
        {!lobby && <PhaseNotices room={room} self={self} />}

        {/* One stable host node across SUBMISSION and PLAYBACK, so the warm
            player is never moved in the DOM (a move would reload the iframe).
            It sits before the phase panels so the video leads the PLAYBACK
            stage; its slot never changes between the two phases. During
            SUBMISSION it keeps a >=200x200 box (Chrome throttles hidden
            frames) but is invisible, unfocusable and non-interactive. In
            PLAYBACK a transparent shield covers the iframe, so hover and
            clicks never reach the YouTube UI (#95). */}
        {(room.phase === 'SUBMISSION' || room.phase === 'PLAYBACK') && (
          <div
            key="playback-host"
            ref={playbackHostRef}
            data-testid="playback-host"
            data-warm={room.phase === 'SUBMISSION'}
            aria-hidden={room.phase === 'SUBMISSION' ? true : undefined}
            tabIndex={room.phase === 'SUBMISSION' ? -1 : undefined}
            className={
              room.phase === 'PLAYBACK'
                ? 'br-stage-video'
                : 'pointer-events-none fixed top-0 left-0 h-[200px] w-[200px] overflow-hidden opacity-0'
            }
          >
            {room.phase === 'PLAYBACK' && (
              <div
                data-testid="playback-shield"
                aria-hidden="true"
                className="br-stage-video__shield"
              />
            )}
          </div>
        )}

        {room.phase === 'GENRE_SPIN' && (
          <GenreSpin session={session} state={state} />
        )}

        {room.phase === 'SUBMISSION' && (
          <SubmissionPanel
            key={`${room.gameNumber}:${room.roundNumber}`}
            session={session}
            state={state}
            viewerId={viewerId}
            room={room}
            roster={roster}
            self={self}
            permissions={permissions}
          />
        )}

        {room.phase === 'PLAYBACK' && (
          <PlaybackPhase
            session={session}
            state={state}
            viewerId={viewerId}
            viewerConnectionId={snapshot.connectionId}
          />
        )}

        {room.phase === 'REVEAL' && (
          <RevealPhase
            key={`${room.gameNumber}:${room.roundNumber}`}
            session={session}
            state={state}
            viewerId={viewerId}
          />
        )}

        {room.phase === 'FINAL' && (
          <FinalPhase
            session={session}
            state={state}
            viewerId={viewerId}
            viewerConnectionId={snapshot.connectionId}
          />
        )}
      </PlaybackControllerContext.Provider>

      {lobby && soundControl}

      {lobby && (
        <SettingsForm
          session={session}
          state={state}
          canEdit={permissions.canEditSettings}
        />
      )}
    </div>
  );

  const actions = (
    <div className="br-table__actions-inner">
      <HostControls
        session={session}
        state={state}
        permissions={permissions}
        readiness={readiness}
      />
      <div className="br-table__share">
        <Button
          tone="blue"
          size="sm"
          data-testid="copy-link"
          onClick={() => {
            void copyLink();
          }}
        >
          {t('lobby.copyLink')}
        </Button>
        <span data-testid="copy-status" role="status" className="br-read">
          {copied === 'copied' ? t('common.copied') : ''}
        </span>
      </div>
      <Button
        tone="slate"
        size="sm"
        data-testid="leave-room"
        className="br-table__leave"
        onClick={onLeave}
      >
        {t('lobby.leave')}
      </Button>
      {copied === 'failed' && (
        <Field
          type="text"
          data-testid="copy-link-fallback"
          label={t('lobby.copyFailed')}
          readOnly
          value={shareUrl}
          onFocus={(event) => event.target.select()}
          className="br-table__fallback"
        />
      )}
    </div>
  );

  const drawer = (
    <>
      <Panel
        as="section"
        data-testid="lobby-readiness"
        data-ready={readiness.ready}
        data-connected={readiness.connectedPlayers}
        className="space-y-1"
      >
        <p>
          {t('sound.playersConnected', {
            connected: readiness.connectedPlayers,
            min: readiness.minPlayers,
            max: readiness.maxPlayers,
          })}
        </p>
        <p className="br-read">
          {readiness.soundLockedIds.length === 0
            ? t('sound.readinessReady')
            : t('sound.readinessWaiting', { min: readiness.minPlayers })}
        </p>
        {readiness.soundLockedIds.length > 0 && (
          <p data-testid="sound-locked-count" className="br-read text-gold">
            {t('sound.soundLocked', {
              count: readiness.soundLockedIds.length,
            })}
          </p>
        )}
      </Panel>
      {!lobby && soundControl}
    </>
  );

  return (
    <TableLayout
      top={
        <>
          {brand}
          <div className="br-table__meta">
            <span className="br-label">{t('lobby.roomCodeLabel')}:</span>
            <span data-testid="room-code" className="br-code br-code--bar">
              {room.roomCode}
            </span>
          </div>
          {controls}
        </>
      }
      phaseBar={
        lobby ? undefined : (
          <PhaseSummary session={session} state={state} room={room} />
        )
      }
      notices={notices}
      side={
        <RosterList
          roster={roster}
          phase={room.phase}
          canKick={permissions.canKick}
          onKick={(playerId) => {
            void kick(playerId);
          }}
        />
      }
      stage={stage}
      actions={actions}
      drawer={drawer}
      footer={footer}
    />
  );
}
