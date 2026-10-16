import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlayerView, RoomView } from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { Badge } from './pf/Badge';
import { Panel, PanelTitle } from './pf/Panel';
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
  // Submission carries its own timer in the panel header.
  const showTimer = room.phase !== 'SUBMISSION';

  return (
    <Panel
      as="section"
      data-testid="phase-summary"
      data-phase={room.phase}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle className="m-0">{t('phase.runningHeading')}</PanelTitle>
        <Badge data-testid="phase-name">{t(`phase.${room.phase}`)}</Badge>
      </div>

      <div className="flex flex-wrap items-stretch gap-3">
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
          <span data-testid="phase-genre" className="br-read self-center">
            {t('phase.genreLabel', {
              genre:
                i18n.resolvedLanguage === 'en' ? room.genre.en : room.genre.de,
            })}
          </span>
        )}
      </div>

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

      {self && !self.isParticipant && room.phase !== 'LOBBY' && (
        <p data-testid="spectator-notice" className="br-notice">
          {t('phase.spectator')}
        </p>
      )}
    </Panel>
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
