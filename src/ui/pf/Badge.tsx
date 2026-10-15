import type { ComponentPropsWithoutRef } from 'react';
import { cx } from './cx';

export type BadgeTone = 'slate' | 'gold' | 'green' | 'red' | 'ghost';

interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  /** slate = neutral, gold = host, green = sound on / done, red = penalty, ghost = spectator. */
  tone?: BadgeTone;
  /** Square dot in front, in the text colour. */
  dot?: boolean;
  /** Pop-in for a badge that just appeared (a fade under reduced motion). */
  isNew?: boolean;
}

/**
 * Pixel-Filz badge (docs/design/pixel-filz/components/Badge): a short
 * Silkscreen tag next to a player name. The status is always a word, never
 * colour alone.
 */
export function Badge({
  tone = 'slate',
  dot = false,
  isNew = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        'br-badge',
        tone !== 'slate' && `br-badge--${tone}`,
        isNew && 'is-new',
        className,
      )}
    >
      {dot && <span aria-hidden="true" className="br-badge__dot" />}
      {children}
    </span>
  );
}
