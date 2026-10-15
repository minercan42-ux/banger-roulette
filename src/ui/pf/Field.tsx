import { useId } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cx } from './cx';

interface FieldCommon {
  label: ReactNode;
  /** Short helper text under the control. Wired up through `aria-describedby`. */
  hint?: ReactNode;
  /** Error state: red frame and hint, one shake (none under reduced motion). */
  invalid?: boolean;
  /** Class names for the field wrapper (layout, e.g. `min-w-0 flex-1`). */
  className?: string;
}

interface FrameProps extends FieldCommon {
  controlId: string;
  hintId: string;
  children: ReactNode;
}

function FieldFrame({
  label,
  hint,
  invalid,
  className,
  controlId,
  hintId,
  children,
}: FrameProps) {
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  return (
    <div className={cx('br-field', invalid === true && 'is-error', className)}>
      <label htmlFor={controlId} className="br-field__label">
        {label}
      </label>
      {children}
      {hasHint && (
        <span id={hintId} className="br-field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

function describedBy(
  hint: ReactNode,
  hintId: string,
  own: string | undefined,
): string | undefined {
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const ids = [own, hasHint ? hintId : undefined].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

type FieldProps = FieldCommon &
  Omit<ComponentPropsWithoutRef<'input'>, 'className' | 'children'>;

/**
 * Pixel-Filz text/number input in a well with a Silkscreen label
 * (docs/design/pixel-filz/components/Field).
 */
export function Field({
  label,
  hint,
  invalid,
  className,
  id,
  'aria-describedby': ariaDescribedBy,
  ...input
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  return (
    <FieldFrame
      label={label}
      hint={hint}
      invalid={invalid}
      className={className}
      controlId={controlId}
      hintId={hintId}
    >
      <input
        {...input}
        id={controlId}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy(hint, hintId, ariaDescribedBy)}
        className="br-field__input"
      />
    </FieldFrame>
  );
}

type SelectFieldProps = FieldCommon &
  Omit<ComponentPropsWithoutRef<'select'>, 'className'>;

/** `Field` for a `<select>`; same frame, label and error behaviour. */
export function SelectField({
  label,
  hint,
  invalid,
  className,
  id,
  children,
  'aria-describedby': ariaDescribedBy,
  ...select
}: SelectFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  return (
    <FieldFrame
      label={label}
      hint={hint}
      invalid={invalid}
      className={className}
      controlId={controlId}
      hintId={hintId}
    >
      <select
        {...select}
        id={controlId}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy(hint, hintId, ariaDescribedBy)}
        className="br-field__input"
      >
        {children}
      </select>
    </FieldFrame>
  );
}
