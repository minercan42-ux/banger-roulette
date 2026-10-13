import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectLobbyReadiness,
  selectReveal,
  selectRoom,
  selectViewerPermissions,
  type PlayerView,
} from '../engine/selectors';
import type { GameSession, SessionSnapshot } from '../net/session';
import type { GameState } from '../shared/game';
import { GenreSpin } from './GenreSpin';
import { HostControls } from './HostControls';
import { MilestoneNotice } from './MilestoneNotice';
import { PhaseSummary } from './PhaseSummary';
import { PhaseUnavailable } from './PhaseUnavailable';
import { PlaybackPhase } from './PlaybackPhase';
import { RosterList } from './RosterList';
import { SettingsForm } from './SettingsForm';
import { SingleSongPhase } from './SingleSongPhase';
import { SoundControl } from './SoundControl';
import { SubmissionPanel } from './SubmissionPanel';

interface RoomViewProps {
  session: GameSession;
  snapshot: SessionSnapshot;
  state: GameState;
  roster: PlayerView[];
  onLeave: () => void;
}

export function RoomView({
  session,
  snapshot,
  state,
  roster,
  onLeave,
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
  const reveal = selectReveal(state);
  const shareUrl = `${window.location.origin}/r/${room.roomCode}`;

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

  return (
    <div data-testid="room-view" data-phase={room.phase} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-cream-100 sm:text-3xl">
            {t('lobby.heading')}
          </h1>
          <p className="mt-1 text-sm text-cream-100/70">
            {t('lobby.roomCodeLabel')}:{' '}
            <span
              data-testid="room-code"
              className="font-mono tracking-[0.3em] text-gold-200 uppercase"
            >
              {room.roomCode}
            </span>
          </p>
        </div>
        <button
          type="button"
          data-testid="leave-room"
          onClick={onLeave}
          className="rounded-md border border-rose-400/40 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/15"
        >
          {t('lobby.leave')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="copy-link"
          onClick={() => {
            void copyLink();
          }}
          className="rounded-md border border-gold-400/40 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/15"
        >
          {t('lobby.copyLink')}
        </button>
        <span
          data-testid="copy-status"
          role="status"
          className="text-xs text-cream-100/70"
        >
          {copied === 'copied' ? t('common.copied') : ''}
        </span>
        {copied === 'failed' && (
          <label className="flex flex-col gap-1 text-xs text-amber-100">
            <span>{t('lobby.copyFailed')}</span>
            <input
              type="text"
              data-testid="copy-link-fallback"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
              className="min-w-0 rounded-md border border-gold-400/40 bg-felt-950 px-2 py-1 text-cream-100"
            />
          </label>
        )}
      </div>

      {self && !permissions.canWrite && (
        <p
          data-testid="read-only-indicator"
          role="status"
          className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          {t('lobby.readOnly')}
        </p>
      )}

      {errorKey && (
        <p
          data-testid="action-error"
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
        >
          {t(errorKey)}
        </p>
      )}

      {!self && (
        <p
          data-testid="player-pending"
          role="status"
          className="rounded-lg border border-gold-400/20 bg-felt-800/60 px-3 py-2 text-sm text-gold-200"
        >
          {t('lobby.waitingForHost')}
        </p>
      )}

      <HostControls
        session={session}
        state={state}
        permissions={permissions}
        readiness={readiness}
      />

      {room.phase !== 'LOBBY' && (
        <PhaseSummary session={session} state={state} room={room} self={self} />
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
        <PlaybackPhase session={session} state={state} viewerId={viewerId} />
      )}

      {room.phase === 'VOTING' && <PhaseUnavailable phase="VOTING" />}

      {room.phase === 'REVEAL' &&
        (reveal?.reason === 'singleSong' ? (
          <SingleSongPhase state={state} viewerId={viewerId} />
        ) : (
          <PhaseUnavailable phase="REVEAL" />
        ))}

      {room.phase === 'FINAL' && <PhaseUnavailable phase="FINAL" />}

      <SoundControl
        session={session}
        canWrite={self !== undefined && permissions.canWrite}
        unlocked={self?.soundUnlocked ?? false}
      />

      <section
        data-testid="lobby-readiness"
        data-ready={readiness.ready}
        data-connected={readiness.connectedPlayers}
        className="rounded-xl border border-gold-400/20 bg-felt-800/50 p-4 text-sm"
      >
        <p className="text-cream-100/80">
          {t('sound.playersConnected', {
            connected: readiness.connectedPlayers,
            min: readiness.minPlayers,
            max: readiness.maxPlayers,
          })}
        </p>
        <p className="mt-1 text-xs text-cream-100/60">
          {readiness.soundLockedIds.length === 0
            ? t('sound.readinessReady')
            : t('sound.readinessWaiting', { min: readiness.minPlayers })}
        </p>
        {readiness.soundLockedIds.length > 0 && (
          <p
            data-testid="sound-locked-count"
            className="mt-1 text-xs text-gold-300"
          >
            {t('sound.soundLocked', {
              count: readiness.soundLockedIds.length,
            })}
          </p>
        )}
      </section>

      <RosterList
        roster={roster}
        canKick={permissions.canKick}
        onKick={(playerId) => {
          void kick(playerId);
        }}
      />

      {room.phase === 'LOBBY' && (
        <SettingsForm
          session={session}
          state={state}
          canEdit={permissions.canEditSettings}
        />
      )}

      <MilestoneNotice />
    </div>
  );
}
