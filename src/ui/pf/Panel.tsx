import type { ComponentPropsWithoutRef, ElementType } from 'react';
import { cx } from './cx';

type PanelProps<T extends ElementType> = {
  as?: T;
  /** Recessed well: room codes, values, inputs. Only inside a panel. */
  well?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'well'>;

/**
 * Pixel-Filz panel (docs/design/pixel-filz/components/Panel): the raised
 * surface for everything that has to be read, or the recessed `well`.
 */
export function Panel<T extends ElementType = 'div'>({
  as,
  well = false,
  className,
  ...rest
}: PanelProps<T>) {
  const Tag: ElementType = as ?? 'div';
  return (
    <Tag
      className={cx('br-panel', well && 'br-panel--well', className)}
      {...rest}
    />
  );
}

interface PanelTitleProps extends ComponentPropsWithoutRef<'h2'> {
  as?: 'h1' | 'h2' | 'h3';
}

/** Panel heading in the `title` style. */
export function PanelTitle({
  as: Tag = 'h2',
  className,
  ...rest
}: PanelTitleProps) {
  return <Tag className={cx('br-panel__title', className)} {...rest} />;
}
