import type { ComponentPropsWithoutRef } from 'react';
import { cx } from './cx';

export type ProgressTone = 'gold' | 'blue';

interface ProgressProps extends Omit<
  ComponentPropsWithoutRef<'div'>,
  'children' | 'role'
> {
  /** Current position, in the same unit as `max`. */
  value: number;
  /** Full-scale value; anything below 1 is treated as 1. */
  max: number;
  /** gold = clip progress, blue = preview (e.g. the voting listen-in). */
  tone?: ProgressTone;
}

/** Fill width in percent, clamped so a late or early update never overflows. */
export function progressPercent(value: number, max: number): number {
  return Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
}

/**
 * Pixel-Filz progress bar (docs/design/pixel-filz/components/Progress): the
 * segmented bar for the clip position. The consumer feeds the position (about
 * four times per second); the width glides linearly between updates.
 */
export function Progress({
  value,
  max,
  tone = 'gold',
  className,
  ...rest
}: ProgressProps) {
  return (
    <div
      {...rest}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.round(Math.max(1, max))}
      aria-valuenow={Math.round(Math.min(Math.max(0, value), Math.max(1, max)))}
      className={cx(
        'br-progress',
        tone === 'blue' && 'br-progress--blue',
        className,
      )}
    >
      <div
        className="br-progress__fill"
        style={{ width: `${progressPercent(value, max)}%` }}
      />
    </div>
  );
}
