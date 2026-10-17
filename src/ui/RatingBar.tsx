import { useTranslation } from 'react-i18next';
import { cx } from './pf/cx';

/** FR-40: 0 is the genre-fail chip, 1 (worst) to 10 (banger) are the numbers. */
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
 * Pixel-style plate with a red cross: the genre-fail symbol on chip 0. Drawn
 * on a 12x12 pixel grid so it stays crisp at any chip size.
 */
function GenreFailGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      className="br-ratechip__glyph"
    >
      <path className="br-ratechip__plate" d="M1 2h10v1h1v7h-1v1H1v-1H0V3h1z" />
      <path
        className="br-ratechip__cross"
        d="M2 3h2v1h-2zM8 3h2v1h-2zM3 4h2v1h-2zM7 4h2v1h-2zM4 5h4v1h-4zM5 6h2v1h-2zM4 7h4v1h-4zM3 8h2v1h-2zM7 8h2v1h-2zM2 9h2v1h-2zM8 9h2v1h-2z"
      />
    </svg>
  );
}

/**
 * Eleven round chip buttons in the order genre-fail (0), 1 to 10 (Pixel-Filz
 * chip style). The chosen chip is the only `aria-pressed` one. The number
 * chips up to the chosen number are filled so the row reads as a bar; the
 * genre-fail chip is a state of its own and is never filled. Plain buttons:
 * Tab and Enter/Space operate it.
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
        const genreFail = rating === 0;
        return (
          <button
            key={rating}
            type="button"
            data-testid={`${chipTestId}-${rating}`}
            aria-pressed={pressed}
            aria-label={
              genreFail
                ? t('rating.genreFailAria')
                : t('rating.chipAria', { value: rating })
            }
            title={genreFail ? t('rating.genreFailAria') : undefined}
            data-kind={genreFail ? 'genre-fail' : undefined}
            disabled={disabled}
            onClick={() => {
              if (!pressed) {
                onRate(rating);
              }
            }}
            className={cx(
              'br-ratechip',
              !genreFail && value !== null && rating <= value && 'is-filled',
              pressed && 'is-on',
              rating === 10 && 'is-ten',
            )}
          >
            <span aria-hidden="true" className="br-ratechip__face">
              {genreFail ? <GenreFailGlyph /> : rating}
            </span>
          </button>
        );
      })}
    </div>
  );
}
