import type { ComponentPropsWithoutRef } from 'react';
import { cx } from './cx';

interface HandProps extends ComponentPropsWithoutRef<'div'> {
  /** Accessible name of the group of cards. */
  label: string;
}

/**
 * Pixel-Filz hand (docs/design/pixel-filz/components/SongCard): cards overlap
 * by 24px. Give each `SongCard` its `index` for the tilt and wobble stagger.
 */
export function Hand({ label, className, children, ...rest }: HandProps) {
  return (
    <div
      {...rest}
      role="group"
      aria-label={label}
      className={cx('br-hand', className)}
    >
      {children}
    </div>
  );
}
