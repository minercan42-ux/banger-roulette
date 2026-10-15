import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlayerView, RoomView } from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { PhaseTimer, Stat } from './pf/Stat';

interface PhaseSummaryProps {
  session: GameSession;
  state: GameState;
  room: RoomView;
  self: PlayerView | undefined;
}

/**
 * Honest running-room status: phase, bounded polite countdown and pause. The
 * M3 game views (roulette, submission) render below; the timer stays generic.
 */
export function PhaseSummary({
  session,
  state,
  room,
  self,
}: PhaseSummaryProps) {
  const { t, i18n } = useTranslation();
  // Submission and voting carry their own timer in the panel header.
  const showTimer = room.phase !== 'SUBMISSION' && room.phase !== 'VOTING';

  return (
    <section
      data-testid="phase-summary"
      data-phase={room.phase}
      className="rounded-xl border border-gold-400/20 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('phase.runningHeading')}
        </h2>
        <span
          data-testid="phase-name"
          className="rounded-full border border-gold-400/30 px-3 py-0.5 text-xs text-gold-200 uppercase"
        >
          {t(`phase.${room.phase}`)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-stretch gap-3">
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
          <span
            data-testid="phase-genre"
            className="self-center text-sm text-cream-100/80"
          >
            {t('phase.genreLabel', {
              genre:
                i18n.resolvedLanguage === 'en' ? room.genre.en : room.genre.de,
            })}
          </span>
        )}
      </div>

      {room.paused && (
        <p
          data-testid="pause-banner"
          role="status"
          className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          <strong>{t('phase.paused')}</strong>{' '}
          {room.pauseReason === 'quorum'
            ? t('phase.pauseQuorum')
            : t('phase.pauseHost')}
        </p>
      )}

      {room.phase === 'FINAL' && (
        <p data-testid="phase-ended" className="mt-3 text-sm text-cream-100/80">
          {t('phase.ended')}
        </p>
      )}

      {self && !self.isParticipant && room.phase !== 'LOBBY' && (
        <p
          data-testid="spectator-notice"
          className="mt-3 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100"
        >
          {t('phase.spectator')}
        </p>
      )}
    </section>
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
