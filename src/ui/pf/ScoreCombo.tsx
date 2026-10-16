import { animate as runAnimation } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatTenths } from '../format';
import { usePrefersReducedMotion } from '../motion';
import { cx } from './cx';

/** The average rating counts up over `--dur-count` (900 ms), then the bonus, then the sum. */
export const COMBO_VOTES_S = 0.9;
export const COMBO_ADJUST_S = 0.3;
export const COMBO_TOTAL_S = 0.6;
/** Whole combo; the reveal gives every song 2500 ms, so it always settles. */
export const COMBO_DURATION_MS =
  (COMBO_VOTES_S + COMBO_ADJUST_S + COMBO_TOTAL_S) * 1000;

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
  className?: string;
}

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
  className,
}: ScoreComboProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [fresh] = useState(animate);
  const playing = fresh && !reducedMotion;
  const [shown, setShown] = useState<ComboValues>(
    playing ? { votes: 0, adjust: 0, total: 0 } : { votes, adjust, total },
  );

  useEffect(() => {
    if (!playing) {
      return;
    }
    let cancelled = false;
    let stop: (() => void) | undefined;
    const count = (
      key: keyof ComboValues,
      target: number,
      seconds: number,
    ): Promise<void> =>
      new Promise((resolve) => {
        if (target === 0) {
          resolve();
          return;
        }
        const controls = runAnimation(0, target, {
          duration: seconds,
          ease: 'linear',
          onUpdate: (latest) => {
            const next = Math.round(latest);
            setShown((previous) =>
              previous[key] === next ? previous : { ...previous, [key]: next },
            );
          },
          onComplete: () => {
            setShown((previous) => ({ ...previous, [key]: target }));
            resolve();
          },
        });
        stop = () => {
          controls.stop();
          resolve();
        };
      });
    void (async () => {
      await count('votes', votes, COMBO_VOTES_S);
      if (!cancelled) {
        await count('adjust', adjust, COMBO_ADJUST_S);
      }
      if (!cancelled) {
        await count('total', total, COMBO_TOTAL_S);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [playing, votes, adjust, total]);

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
