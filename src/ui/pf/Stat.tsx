import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { selectPhaseTimer } from '../../engine/selectors';
import type { GameSession } from '../../net/session';
import type { GameState } from '../../shared/game';
import { formatDuration } from '../format';
import { useSessionNow } from '../use-session-now';
import { cx } from './cx';

/** The timer turns red and ticks once per second at this remaining time. */
export const URGENT_MS = 10_000;

/** The polite timer announcement only changes every ten seconds. */
const ANNOUNCE_STEP_MS = 10_000;

/** Timer redraw rate; the text only changes once per second. */
const TIMER_FRAME_MS = 250;

interface StatProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  /** Silkscreen label above the number. */
  label: ReactNode;
  /** The number as text (`0:42`, `3/5`). */
  value: ReactNode;
  /** Red, ticking number (the last ten seconds of a timer). */
  urgent?: boolean;
}

/**
 * Pixel-Filz stat (docs/design/pixel-filz/components/Stat): a recessed well
 * with a Silkscreen label and a big gold number for timers, done counters and
 * the round. Pass `role="timer"` for a countdown.
 */
export function Stat({
  label,
  value,
  urgent = false,
  className,
  ...rest
}: StatProps) {
  const labelId = useId();
  return (
    <div
      aria-labelledby={labelId}
      {...rest}
      className={cx('br-stat', urgent && 'is-urgent', className)}
    >
      <span id={labelId} className="br-label">
        {label}
      </span>
      <span className="br-stat__value">{value}</span>
    </div>
  );
}

/** Remaining time against an absolute deadline; a pause freezes the clock. */
export function remainingUntil(
  deadlineAt: number,
  now: number,
  pausedAt: number | null,
): number {
  return Math.max(0, deadlineAt - (pausedAt ?? now));
}

interface TimerStatProps extends Omit<
  StatProps,
  'value' | 'urgent' | 'role' | 'label'
> {
  session: GameSession;
  /** Absolute server time the countdown runs to (NFR-02: no ticker messages). */
  deadlineAt: number;
  /** Server time the game was paused at, or `null` while it runs. */
  pausedAt: number | null;
  label: ReactNode;
  /** Sentence for the bounded polite announcement; omit for no live region. */
  announce?: (time: string) => string;
  /** Test id of the live region (the stat itself takes `data-testid`). */
  liveTestId?: string;
}

/**
 * Countdown stat. It computes `deadlineAt - session.now()` locally; nothing
 * ticks over the network. At 10 s or less the number turns red (and ticks once
 * per second, still under reduced motion only the colour changes). Screen
 * readers get the timer role plus a polite region that changes every 10 s.
 */
export function TimerStat({
  session,
  deadlineAt,
  pausedAt,
  label,
  announce,
  liveTestId,
  ...rest
}: TimerStatProps) {
  const now = useSessionNow(session, pausedAt === null, TIMER_FRAME_MS);
  const remaining = remainingUntil(deadlineAt, now, pausedAt);
  const announcement =
    announce === undefined
      ? ''
      : announce(
          formatDuration(Math.floor(remaining / ANNOUNCE_STEP_MS) * 10_000),
        );
  return (
    <>
      <Stat
        {...rest}
        role="timer"
        label={label}
        value={formatDuration(remaining)}
        urgent={remaining <= URGENT_MS}
        data-paused={pausedAt !== null}
        data-remaining-ms={Math.round(remaining)}
      />
      {announce !== undefined && (
        <span data-testid={liveTestId} aria-live="polite" className="sr-only">
          {announcement}
        </span>
      )}
    </>
  );
}

interface PhaseTimerProps {
  session: GameSession;
  state: GameState;
  label: ReactNode;
  announce: (time: string) => string;
}

/**
 * The timer of the running phase from the engine's `selectPhaseTimer`; renders
 * nothing for phases without a deadline.
 */
export function PhaseTimer({
  session,
  state,
  label,
  announce,
}: PhaseTimerProps) {
  const timer = selectPhaseTimer(state, session.now());
  if (timer.deadlineAt === null) {
    return null;
  }
  return (
    <TimerStat
      session={session}
      deadlineAt={timer.deadlineAt}
      pausedAt={state.pause?.at ?? null}
      label={label}
      announce={announce}
      data-testid="phase-timer"
      liveTestId="phase-timer-live"
    />
  );
}
