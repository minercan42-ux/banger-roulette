import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlayerView, RoomView } from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { Badge } from './pf/Badge';
import { PhaseTimer, Stat } from './pf/Stat';

interface PhaseSummaryProps {
  session: GameSession;
  state: GameState;
  room: RoomView;
}

/**
 * Honest running-room status for the table's top bar: phase, round, bounded
 * polite countdown and genre. The M3 game views (roulette, submission) render
 * in the stage; the timer stays generic. Pause and spectator notes live in
 * `PhaseNotices`, which the stage places.
 */
export function PhaseSummary({ session, state, room }: PhaseSummaryProps) {
  const { t, i18n } = useTranslation();
  // Submission carries its own timer in the panel header.
  const showTimer = room.phase !== 'SUBMISSION';

  return (
    <div
      data-testid="phase-summary"
      data-phase={room.phase}
      className="br-table__summary"
    >
      <Badge data-testid="phase-name">{t(`phase.${room.phase}`)}</Badge>
      {room.roundNumber !== null && (
        <Stat
          data-testid="phase-round"
          label={t('phase.roundStat')}
          value={`${room.roundNumber}/${room.totalRounds}`}
        />
      )}
      {showTimer && (
        <PhaseTimer
          session={session}
          state={state}
          label={t('phase.timerLabel')}
          announce={(time) => t('phase.timerAnnounce', { time })}
        />
      )}
      {room.genre && (
        <span data-testid="phase-genre" className="br-read">
          {t('phase.genreLabel', {
            genre:
              i18n.resolvedLanguage === 'en' ? room.genre.en : room.genre.de,
          })}
        </span>
      )}
    </div>
  );
}

interface PhaseNoticesProps {
  room: RoomView;
  self: PlayerView | undefined;
}

/** Pause banner, end note and spectator hint above the running phase. */
export function PhaseNotices({ room, self }: PhaseNoticesProps) {
  const { t } = useTranslation();
  const spectator = self && !self.isParticipant && room.phase !== 'LOBBY';
  if (!room.paused && room.phase !== 'FINAL' && !spectator) {
    return null;
  }
  return (
    <div className="space-y-2">
      {room.paused && (
        <p data-testid="pause-banner" role="status" className="br-notice">
          <strong>{t('phase.paused')}</strong>{' '}
          {room.pauseReason === 'quorum'
            ? t('phase.pauseQuorum')
            : t('phase.pauseHost')}
        </p>
      )}

      {room.phase === 'FINAL' && (
        <p data-testid="phase-ended" className="br-read">
          {t('phase.ended')}
        </p>
      )}

      {spectator && (
        <p data-testid="spectator-notice" className="br-notice">
          {t('phase.spectator')}
        </p>
      )}
    </div>
  );
}

interface PhaseAnnouncerProps {
  room: RoomView;
}

/**
 * SPEC §6 phase live region. It is mounted by `RoomView` for the whole room
 * lifecycle, including LOBBY, so the lobby boundary itself is announced. It
 * stays silent on its first mount (entering the room, a reload or reconnect is
 * not a transition) and then announces the localized phase name plus the round
 * on every observed change.
 */
export function PhaseAnnouncer({ room }: PhaseAnnouncerProps) {
  const { t } = useTranslation();
  const lastPhaseRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const previousPhase = lastPhaseRef.current;
    lastPhaseRef.current = room.phase;
    if (previousPhase === null || previousPhase === room.phase) {
      return;
    }
    const phase = t(`phase.${room.phase}`);
    setAnnouncement(
      room.roundNumber === null
        ? t('a11y.phaseAnnouncementNoRound', { phase })
        : t('a11y.phaseAnnouncement', {
            phase,
            number: room.roundNumber,
            total: room.totalRounds,
          }),
    );
  }, [room.phase, room.roundNumber, room.totalRounds, t]);

  return (
    <span
      data-testid="phase-announcement"
      aria-live="polite"
      className="sr-only"
    >
      {announcement}
    </span>
  );
}
