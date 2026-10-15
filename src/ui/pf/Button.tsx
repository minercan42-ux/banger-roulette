import type { ComponentPropsWithoutRef } from 'react';
import { cx } from './cx';

export type ButtonTone = 'gold' | 'blue' | 'red' | 'slate';

interface ButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'aria-pressed'
> {
  /** gold = primary (one per area), blue = secondary, red = destructive, slate = tertiary. */
  tone?: ButtonTone;
  size?: 'md' | 'sm';
  /** Toggle state: sets `aria-pressed` and `.is-on`. Leave undefined for a plain button. */
  pressed?: boolean;
}

/**
 * Pixel-Filz button (docs/design/pixel-filz/components/Button). Hover tilt,
 * press sink and the disabled look all live in the `br-btn` classes, with the
 * reduced-motion fallback in `styles.css`.
 */
export function Button({
  tone = 'gold',
  size = 'md',
  pressed,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={pressed}
      className={cx(
        'br-btn',
        tone !== 'gold' && `br-btn--${tone}`,
        size === 'sm' && 'br-btn--sm',
        pressed === true && 'is-on',
        className,
      )}
    />
  );
}
