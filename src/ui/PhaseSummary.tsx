import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectPhaseTimer,
  type PlayerView,
  type RoomView,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { formatDuration } from './format';

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
  const [now, setNow] = useState(() => session.now());
  const timer = selectPhaseTimer(state, now);
  const remaining = timer.remainingMs;

  useEffect(() => {
    if (timer.deadlineAt === null || timer.paused) {
      return;
    }
    const id = window.setInterval(() => setNow(session.now()), 250);
    return () => window.clearInterval(id);
  }, [timer.deadlineAt, timer.paused, session]);

  // Bounded polite announcement: the text only changes every ten seconds.
  const announcement =
    remaining === null
      ? ''
      : formatDuration(Math.floor(remaining / 10000) * 10000);

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

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-cream-100/80">
        {room.roundNumber !== null && (
          <span data-testid="phase-round">
            {t('phase.roundLabel', {
              number: room.roundNumber,
              total: room.totalRounds,
            })}
          </span>
        )}
        {room.genre && (
          <span data-testid="phase-genre">
            {t('phase.genreLabel', {
              genre:
                i18n.resolvedLanguage === 'en' ? room.genre.en : room.genre.de,
            })}
          </span>
        )}
      </div>

      {timer.deadlineAt !== null && (
        <div className="mt-3">
          <span className="text-xs text-cream-100/60">
            {t('phase.timerLabel')}
          </span>
          <div
            data-testid="phase-timer"
            data-paused={timer.paused}
            data-remaining-ms={remaining ?? 0}
            aria-hidden="true"
            className="font-display text-2xl text-gold-200"
          >
            {formatDuration(remaining ?? 0)}
          </div>
          <span
            data-testid="phase-timer-live"
            aria-live="polite"
            className="sr-only"
          >
            {announcement}
          </span>
        </div>
      )}

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
