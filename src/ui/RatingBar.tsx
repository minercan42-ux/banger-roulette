import { useTranslation } from 'react-i18next';
import { cx } from './pf/cx';

/** FR-40: integer ratings 0 (worst) to 10 (banger). */
export const RATINGS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

interface RatingBarProps {
  /** The viewer's current rating of the song; null while unrated. */
  value: number | null;
  disabled: boolean;
  /** Group name read by screen readers ("Rate Song 3"). */
  label: string;
  /** `data-testid` of the group and prefix of the chips (`<prefix>-<n>`). */
  testId: string;
  chipTestId: string;
  onRate: (value: number) => void;
}

/**
 * Eleven round chip buttons, one per rating (Pixel-Filz chip style). The
 * chosen value is the only `aria-pressed` one; every chip below it is filled
 * so the row reads as a bar. Plain buttons: Tab and Enter/Space operate it.
 */
export function RatingBar({
  value,
  disabled,
  label,
  testId,
  chipTestId,
  onRate,
}: RatingBarProps) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      data-value={value ?? ''}
      className="br-ratebar"
    >
      {RATINGS.map((rating) => {
        const pressed = value === rating;
        return (
          <button
            key={rating}
            type="button"
            data-testid={`${chipTestId}-${rating}`}
            aria-pressed={pressed}
            aria-label={t('rating.chipAria', { value: rating })}
            disabled={disabled}
            onClick={() => {
              if (!pressed) {
                onRate(rating);
              }
            }}
            className={cx(
              'br-ratechip',
              value !== null && rating <= value && 'is-filled',
              pressed && 'is-on',
              rating === 10 && 'is-ten',
            )}
          >
            <span aria-hidden="true" className="br-ratechip__face">
              {rating}
            </span>
          </button>
        );
      })}
    </div>
  );
}
