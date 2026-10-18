import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatTenths } from '../format';
import { usePrefersReducedMotion } from '../motion';
import { cx } from './cx';

/** The average rating counts up over `--dur-count` (900 ms), then the bonus, then the sum. */
export const COMBO_VOTES_S = 0.9;
export const COMBO_ADJUST_S = 0.3;
export const COMBO_TOTAL_S = 0.6;
/** Whole combo; the reveal gives every song 2500 ms, so it always settles. */
export const COMBO_DURATION_MS = Math.round(
  (COMBO_VOTES_S + COMBO_ADJUST_S + COMBO_TOTAL_S) * 1000,
);

/** All values are integer tenths of a point (73 shows as 7.3). */
export interface ComboValues {
  /** Average rating of the song. */
  votes: number;
  /** Signed change between the average and the round score (jackpot bonus, genre-fail penalty, linked share). */
  adjust: number;
  /** Round score, exactly the engine's value. */
  total: number;
}

/**
 * Splits an engine reveal entry into the three boxes. `adjust` is derived from
 * the engine's round score, so `votes + adjust === total` always holds even
 * when a genre fail or a linked song shares the points.
 */
export function comboValues(entry: {
  scoreTenths: number;
  roundPoints: number;
}): ComboValues {
  return {
    votes: entry.scoreTenths,
    adjust: entry.roundPoints - entry.scoreTenths,
    total: entry.roundPoints,
  };
}

export type ComboKind = 'jackpot' | 'penalty' | 'shared';

/**
 * What the middle box stands for: a genre fail turns it into a penalty, a
 * linked song that splits its points into a share, otherwise it is the
 * jackpot bonus (0 for a song that did not win).
 */
export function comboKind(entry: {
  scoreTenths: number;
  bonus: number;
  roundPoints: number;
  genreFailed: boolean;
}): ComboKind {
  if (entry.genreFailed) {
    return 'penalty';
  }
  return entry.roundPoints === entry.scoreTenths + entry.bonus
    ? 'jackpot'
    : 'shared';
}

/**
 * One timeline for the three boxes, read off the shared clock: the votes count
 * for 900 ms, then the bonus for 300 ms, then the sum for 600 ms. A box whose
 * value is 0 takes no time. The frame is a pure function of the elapsed time,
 * so a late or dropped frame never delays a later stage.
 */
function stageWindows(
  values: ComboValues,
): Record<keyof ComboValues, [number, number]> {
  let at = 0;
  const window = (target: number, seconds: number): [number, number] => {
    const start = at;
    if (target === 0) {
      return [start, 0];
    }
    at += Math.round(seconds * 1000);
    return [start, Math.round(seconds * 1000)];
  };
  const votes = window(values.votes, COMBO_VOTES_S);
  const adjust = window(values.adjust, COMBO_ADJUST_S);
  const total = window(values.total, COMBO_TOTAL_S);
  return { votes, adjust, total };
}

/** When the sum is settled, in ms after the entry's reveal time (at most `COMBO_DURATION_MS`). */
export function comboDurationMs(values: ComboValues): number {
  const { total } = stageWindows(values);
  return total[0] + total[1];
}

/** The numbers shown `elapsedMs` after the entry's reveal time. */
export function comboFrame(
  values: ComboValues,
  elapsedMs: number,
): ComboValues {
  const windows = stageWindows(values);
  const ramp = (key: keyof ComboValues): number => {
    const [start, length] = windows[key];
    const target = values[key];
    if (elapsedMs >= start + length) {
      return target;
    }
    if (elapsedMs <= start) {
      return 0;
    }
    return Math.round((target * (elapsedMs - start)) / length);
  };
  return { votes: ramp('votes'), adjust: ramp('adjust'), total: ramp('total') };
}

/** Frame and timer primitives, injected so the timeline is testable without a DOM. */
export interface ComboScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

/**
 * Pushes `comboFrame(values, elapsed())` on every animation frame until the sum
 * is settled. A timer armed for the settle time guarantees the final numbers
 * even if the frame clock is starved (loaded browser, hidden tab): the total
 * appears at its scheduled time whatever the frame count. Returns the stop
 * function.
 */
export function runComboTimeline(
  values: ComboValues,
  elapsed: () => number,
  onFrame: (frame: ComboValues) => void,
  scheduler: ComboScheduler,
): () => void {
  const duration = comboDurationMs(values);
  let frame: number | undefined;
  let timer: number | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (frame !== undefined) {
      scheduler.cancelFrame(frame);
    }
    if (timer !== undefined) {
      scheduler.clearTimer(timer);
    }
  };
  /** Shows the frame for now; true once the sum is settled. */
  const tick = (): boolean => {
    const at = elapsed();
    onFrame(comboFrame(values, at));
    if (at >= duration) {
      stop();
      return true;
    }
    return false;
  };
  const loop = () => {
    if (!stopped && !tick()) {
      frame = scheduler.requestFrame(loop);
    }
  };
  const arm = () => {
    timer = scheduler.setTimer(
      () => {
        if (!stopped && !tick()) {
          arm();
        }
      },
      Math.max(duration - elapsed(), 1),
    );
  };
  loop();
  if (!stopped) {
    arm();
  }
  return stop;
}

interface ScoreComboProps extends ComboValues {
  /** Captions under the boxes. */
  votesLabel: string;
  adjustLabel: ReactNode;
  totalLabel: string;
  /**
   * Count up from zero. Read once on mount: a song that is already settled
   * (reload, late join) must not start counting. Reduced motion always shows
   * the final values immediately.
   */
  animate?: boolean;
  /**
   * Shared-clock time at which the song's reveal slot starts (the entry's
   * `revealAt`). The count-up is a function of `now() - startedAt`, so a
   * dropped frame never delays the settled total. Defaults to the mount time.
   */
  startedAt?: number;
  /** Shared clock in ms (the session's server-synced `now`); defaults to `Date.now`. */
  now?: () => number;
  /** Reveal pause instant on the shared clock; the combo holds that frame. */
  pausedAt?: number | null;
  className?: string;
}

const windowScheduler: ComboScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
};

function signed(value: number): string {
  return value < 0 ? '-' : '+';
}

/** Restarts the `br-bump` pop whenever the shown number changes. */
function useBump(value: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const element = ref.current;
    if (element === null) {
      return;
    }
    element.classList.remove('br-bump');
    // Force a reflow so the animation restarts on the same element.
    void element.offsetWidth;
    element.classList.add('br-bump');
  }, [value]);
  return ref;
}

/**
 * Pixel-Filz score combo (docs/design/pixel-filz/components/ScoreCombo): the
 * round points as a blue votes box plus a red bonus box equals a gold sum,
 * counted up in that order. The boxes are decoration; the consumer provides
 * the text the screen reader gets (the reveal announces the final score once).
 */
export function ScoreCombo({
  votes,
  adjust,
  total,
  votesLabel,
  adjustLabel,
  totalLabel,
  animate = true,
  startedAt,
  now = Date.now,
  pausedAt = null,
  className,
}: ScoreComboProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [fresh] = useState(animate);
  const playing = fresh && !reducedMotion;
  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  }, [now]);
  // Without a shared start the count-up begins at mount.
  const [mountedAt] = useState(() => now());
  const origin = startedAt ?? mountedAt;
  const [shown, setShown] = useState<ComboValues>(() =>
    playing
      ? comboFrame({ votes, adjust, total }, (pausedAt ?? now()) - origin)
      : { votes, adjust, total },
  );

  useEffect(() => {
    if (!playing) {
      return;
    }
    const values = { votes, adjust, total };
    const apply = (frame: ComboValues) =>
      setShown((previous) =>
        previous.votes === frame.votes &&
        previous.adjust === frame.adjust &&
        previous.total === frame.total
          ? previous
          : frame,
      );
    if (pausedAt !== null) {
      apply(comboFrame(values, pausedAt - origin));
      return;
    }
    return runComboTimeline(
      values,
      () => nowRef.current() - origin,
      apply,
      windowScheduler,
    );
  }, [playing, votes, adjust, total, origin, pausedAt]);

  const display = playing ? shown : { votes, adjust, total };
  const votesRef = useBump(display.votes);
  const adjustRef = useBump(display.adjust);
  const totalRef = useBump(display.total);

  return (
    <div
      data-testid="score-combo"
      data-votes={votes}
      data-adjust={adjust}
      data-total={total}
      aria-hidden="true"
      className={cx('br-combo-block', className)}
    >
      <div className="br-combo">
        <span
          ref={votesRef}
          data-testid="score-combo-votes"
          className="br-combo__box br-combo__box--votes"
        >
          {formatTenths(display.votes)}
        </span>
        <span className="br-combo__op">{signed(adjust)}</span>
        <span
          ref={adjustRef}
          data-testid="score-combo-adjust"
          className="br-combo__box br-combo__box--bonus"
        >
          {formatTenths(Math.abs(display.adjust))}
        </span>
        <span className="br-combo__op">=</span>
        <span
          ref={totalRef}
          data-testid="score-combo-total"
          className="br-combo__box br-combo__box--total"
        >
          {formatTenths(display.total)}
        </span>
      </div>
      <div className="br-combo__caption br-label">
        <span>{votesLabel}</span>
        <span>{adjustLabel}</span>
        <span>{totalLabel}</span>
      </div>
    </div>
  );
}
