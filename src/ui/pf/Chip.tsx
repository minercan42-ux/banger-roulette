import type { CSSProperties } from 'react';
import { cx } from './cx';

export type ChipTone = 'red' | 'blue' | 'gold';
export type ChipSize = 'sm' | 'md' | 'lg';

interface ChipProps {
  /** blue = votes, red = bonus/jackpot, gold = win. */
  tone?: ChipTone;
  /** `sm` (20px) sits inside badges; `md` is the 32px base, `lg` is 48px. */
  size?: ChipSize;
  /** Accessible name ("5 points"). Without it the chip is decorative (`aria-hidden`). */
  label?: string;
  /** Drop-in animation; stagger with `style={{ animationDelay }}`. */
  drop?: boolean;
  style?: CSSProperties;
}

/**
 * Pixel-Filz poker chip (docs/design/pixel-filz/components/Chip), pure CSS.
 */
export function Chip({
  tone = 'red',
  size = 'md',
  label,
  drop = false,
  style,
}: ChipProps) {
  const labelled = label !== undefined && label !== '';
  return (
    <span
      data-testid="chip"
      data-tone={tone}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : true}
      style={style}
      className={cx(
        'br-chip',
        tone !== 'red' && `br-chip--${tone}`,
        size !== 'md' && `br-chip--${size}`,
        drop && 'is-drop',
      )}
    />
  );
}
