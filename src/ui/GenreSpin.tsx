import { useTranslation } from 'react-i18next';
import {
  selectGenrePool,
  selectPhaseTimer,
  selectRoom,
  selectSettings,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import type { Genre } from '../shared/primitives';
import { genreName } from './format';
import { usePrefersReducedMotion } from './motion';
import { useSessionNow } from './use-session-now';

interface GenreSpinProps {
  session: GameSession;
  state: GameState;
}

/** Deterministic extra turns so every client animates the same path (FR-10). */
const SPIN_TURNS = 5;

/**
 * Deterministic final rotation, in degrees, for the genre at `index` of the
 * pool. The segment centre lands under the top pointer; identical on every
 * client because it only depends on the shared pool order and genre id.
 */
export function genreTargetAngle(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  const safeIndex = index < 0 ? 0 : index;
  const segment = 360 / count;
  return SPIN_TURNS * 360 - (safeIndex * segment + segment / 2);
}

function polar(radius: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: 100 + radius * Math.sin(radians),
    y: 100 - radius * Math.cos(radians),
  };
}

function segmentPath(index: number, count: number): string {
  const segment = 360 / count;
  const start = polar(92, index * segment);
  const end = polar(92, (index + 1) * segment);
  const largeArc = segment > 180 ? 1 : 0;
  return `M 100 100 L ${start.x} ${start.y} A 92 92 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

/**
 * FR-10 genre roulette. The result is already in the snapshot; the animation
 * only derives its rotation from the shared phase deadline so a late mount, a
 * reload or a pause freezes on the same angle instead of rerolling. Fixed mode
 * shows a short notice instead of a spin.
 */
export function GenreSpin({ session, state }: GenreSpinProps) {
  const { t, i18n } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const room = selectRoom(state);
  const pool = selectGenrePool(state);
  const genre = room.genre;
  const spinMode = selectSettings(state).genreMode !== 'fixed';
  const now = useSessionNow(session, spinMode && !reducedMotion);
  const timer = selectPhaseTimer(state, now);

  if (!genre) {
    return null;
  }
  const label = genreName(genre, i18n.resolvedLanguage);

  const elapsed =
    timer.totalMs !== null && timer.remainingMs !== null
      ? timer.totalMs - timer.remainingMs
      : Number.POSITIVE_INFINITY;
  const progress =
    timer.totalMs !== null && timer.totalMs > 0
      ? Math.min(1, Math.max(0, elapsed / timer.totalMs))
      : 1;
  const eased = reducedMotion ? 1 : 1 - (1 - progress) ** 3;
  const index = pool.findIndex((candidate) => candidate.id === genre.id);
  const targetAngle = genreTargetAngle(index, pool.length);
  const rotation = eased * targetAngle;

  return (
    <section
      data-testid="genre-spin"
      className="rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('genre.heading')}
        </h2>
        <span className="text-xs text-cream-100/60">
          {t('genre.resultLabel')}
        </span>
      </div>

      {spinMode ? (
        <div className="mt-4 flex flex-col items-center gap-3">
          <div className="relative h-64 w-64 max-w-full">
            <svg
              data-testid="genre-wheel"
              data-genre-id={genre.id}
              data-target-angle={Math.round(targetAngle)}
              viewBox="0 0 200 200"
              role="img"
              aria-label={t('genre.announcement', { genre: label })}
              className="h-full w-full"
            >
              <g
                style={{
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: '100px 100px',
                  transition: reducedMotion ? 'none' : undefined,
                }}
              >
                {pool.map((entry: Genre, segmentIndex: number) => (
                  <path
                    key={entry.id}
                    d={segmentPath(segmentIndex, pool.length)}
                    fill={segmentIndex % 2 === 0 ? '#14532d' : '#0b0b0b'}
                    stroke="#d4af37"
                    strokeWidth="0.4"
                  >
                    <title>{genreName(entry, i18n.resolvedLanguage)}</title>
                  </path>
                ))}
                {pool.map((entry: Genre, segmentIndex: number) => {
                  const segment = 360 / pool.length;
                  const position = polar(
                    62,
                    segmentIndex * segment + segment / 2,
                  );
                  return (
                    <text
                      key={entry.id}
                      x={position.x}
                      y={position.y}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={pool.length <= 16 ? 5 : 3}
                      fill="#f5e7c1"
                    >
                      {genreName(entry, i18n.resolvedLanguage).slice(
                        0,
                        pool.length <= 16 ? 12 : 3,
                      )}
                    </text>
                  );
                })}
              </g>
              <circle
                cx="100"
                cy="100"
                r="92"
                fill="none"
                stroke="#d4af37"
                strokeWidth="1.5"
              />
              <circle cx="100" cy="100" r="9" fill="#d4af37" />
            </svg>
            <span
              aria-hidden="true"
              className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 border-x-[7px] border-t-[12px] border-x-transparent border-t-gold-300"
            />
          </div>
          {!reducedMotion && progress < 1 && (
            <p className="text-xs text-cream-100/60">{t('genre.spinning')}</p>
          )}
        </div>
      ) : (
        <p
          data-testid="genre-fixed-notice"
          className="mt-3 rounded-lg border border-gold-400/25 bg-felt-900/60 px-3 py-2 text-sm text-cream-100/80"
        >
          {t('genre.fixedNotice')}
        </p>
      )}

      <p className="mt-3 text-sm text-cream-100/80">
        {t('genre.resultLabel')}:{' '}
        <span
          data-testid="genre-result"
          className="font-display text-lg text-gold-200"
        >
          {label}
        </span>
      </p>
      <span
        data-testid="genre-announcement"
        aria-live="polite"
        className="sr-only"
      >
        {progress >= 1 ? t('genre.announcement', { genre: label }) : ''}
      </span>
    </section>
  );
}
