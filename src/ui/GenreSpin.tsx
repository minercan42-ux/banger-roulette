import { memo, useEffect, useMemo, useState } from 'react';
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
import { GenrePlate } from './pf/GenrePlate';
import { useSessionNow } from './use-session-now';

interface GenreSpinProps {
  session: GameSession;
  state: GameState;
}

/** Deterministic extra turns so every client animates the same path (FR-10). */
const SPIN_TURNS = 5;

/** Spin path length; the stylesheet's `--dur-spin`. */
export const WHEEL_SPIN_MS = 2580;
/** Shake at the stop; `.br-shake` lasts 420 ms. */
export const WHEEL_SHAKE_MS = 420;
/** One pointer flick per passed segment; `.br-wheel__pointer.is-tick`. */
export const POINTER_TICK_MS = 140;

/** Frame cadence of the spin; the wheel is the only moving thing on screen. */
const FRAME_MS = 16;

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

/** Control points of `--ease-wheel` in `styles.css` (cubic-bezier(.12,.62,.08,1)). */
export const WHEEL_EASE = [0.12, 0.62, 0.08, 1] as const;

function bezier(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** The design curve, `x` in [0, 1] to progress, solved by bisection. */
function curve(x: number): number {
  const [x1, y1, x2, y2] = WHEEL_EASE;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 48; step += 1) {
    const mid = (low + high) / 2;
    if (bezier(mid, x1, x2) < x) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return bezier((low + high) / 2, y1, y2);
}

/**
 * The design curve speeds up for its first ~85 ms (slope 5.17 to 5.75) before
 * it brakes. The wheel must never accelerate (FR-10, the angular velocity is
 * monotone non-increasing), so the launch is flattened: up to the tangent
 * point from the origin, the wheel turns at that tangent's constant speed
 * (the maximum of progress over x); from there on it is the unchanged curve,
 * which is C1 at the joint and brakes monotonically to rest. The path stays
 * within 0.4 % of the full travel of the design curve.
 */
const LAUNCH = (() => {
  const [x1, y1, x2] = WHEEL_EASE;
  let best = { x: 0, slope: y1 / x1 };
  for (let step = 1; step <= 4096; step += 1) {
    const t = step / 4096;
    const x = bezier(t, x1, x2);
    const slope = bezier(t, y1, WHEEL_EASE[3]) / x;
    if (slope > best.slope) {
      best = { x, slope };
    }
  }
  return best;
})();

/**
 * `--ease-wheel` as a pure function of linear progress `x` in [0, 1], so every
 * client gets the same value for the same server-synced time. Rises from 0 to
 * exactly 1 and its speed never increases.
 */
export function wheelEase(x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x <= LAUNCH.x ? LAUNCH.slope * x : curve(x);
}

export interface WheelTimeline {
  /** Length of the spin path. */
  spinMs: number;
  /** Shake right after the stop. */
  shakeMs: number;
}

/**
 * Split the genre phase into spin and shake. The phase length (`SPIN_MS` in
 * the engine) is authoritative: when 2580 ms + 420 ms do not fit, the shake
 * shrinks first and the spin only compresses once the phase is shorter than
 * the spin itself. Spin plus shake never run past the deadline, and the
 * end angle is the target either way.
 */
export function wheelTimeline(totalMs: number): WheelTimeline {
  const total = Math.max(0, totalMs);
  const spinMs = Math.min(WHEEL_SPIN_MS, total);
  const shakeMs = Math.min(WHEEL_SHAKE_MS, total - spinMs);
  return { spinMs, shakeMs };
}

/**
 * Wheel rotation in degrees `elapsedMs` after the phase started. A pure
 * function of the shared clock: late mounts, reloads and pauses land on the
 * same angle, and from `spinMs` on it is exactly `targetAngle`.
 */
export function wheelAngle(
  elapsedMs: number,
  spinMs: number,
  targetAngle: number,
): number {
  if (spinMs <= 0 || elapsedMs >= spinMs) {
    return targetAngle;
  }
  return targetAngle * wheelEase(elapsedMs / spinMs);
}

/** Segment boundaries the pointer has passed at `angle`; one flick each. */
export function wheelTicks(angle: number, count: number): number {
  if (count <= 0 || angle <= 0) {
    return 0;
  }
  return Math.floor(angle / (360 / count));
}

/**
 * Label type for a wheel of `count` segments: as large as the arc allows
 * (21 units for the usual 12 genres) and cut to what fits between hub and rim.
 */
export function wheelLabelLayout(count: number): {
  fontSize: number;
  maxChars: number;
} {
  const arc = (2 * Math.PI * 92) / Math.max(count, 1);
  const fontSize = Math.max(8, Math.min(21, Math.floor(arc * 0.8)));
  return { fontSize, maxChars: Math.max(3, Math.floor(96 / (fontSize * 0.5))) };
}

function wheelLabel(name: string, maxChars: number): string {
  const chars = [...name];
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars - 1).join('')}.`
    : name;
}

function polar(radius: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return { x: radius * Math.sin(radians), y: -radius * Math.cos(radians) };
}

function segmentPath(index: number, count: number): string {
  const segment = 360 / count;
  const start = polar(140, index * segment);
  const end = polar(140, (index + 1) * segment);
  const largeArc = segment > 180 ? 1 : 0;
  return `M 0 0 L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A 140 140 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

const BULBS = 24;

interface WheelFaceProps {
  pool: readonly Genre[];
  language: string | undefined;
}

/**
 * The disc artwork. Memoised: the rotation lives on the parent `svg`, so the
 * frame-rate re-renders of the spin never rebuild up to 50 segments.
 */
const WheelFace = memo(function WheelFace({ pool, language }: WheelFaceProps) {
  const count = pool.length;
  const segment = 360 / count;
  const { fontSize, maxChars } = wheelLabelLayout(count);
  return (
    <>
      <circle r="156" fill="var(--color-edge)" />
      <circle r="148" fill="var(--color-gold-deep)" />
      {pool.map((entry, index) => {
        const dark = index === 0 || index % 2 === 1;
        const name = genreName(entry, language);
        return (
          <g key={entry.id}>
            <path
              d={segmentPath(index, count)}
              fill={
                index === 0
                  ? 'var(--color-swirl-green)'
                  : dark
                    ? 'var(--color-well)'
                    : 'var(--color-red)'
              }
              stroke="var(--color-edge)"
              strokeWidth="3"
            >
              <title>{name}</title>
            </path>
            <text
              transform={`rotate(${index * segment + segment / 2 - 90}) translate(92 0)`}
              fill={dark ? 'var(--color-cream)' : 'var(--color-card-ink)'}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={fontSize}
              style={{ fontFamily: 'var(--font-pixel)' }}
            >
              {wheelLabel(name, maxChars)}
            </text>
          </g>
        );
      })}
      {Array.from({ length: BULBS }, (_, bulb) => {
        const position = polar(152, (bulb * 360) / BULBS);
        return (
          <rect
            key={bulb}
            x={(position.x - 4).toFixed(1)}
            y={(position.y - 4).toFixed(1)}
            width="8"
            height="8"
            className={`br-wheel__bulb${bulb % 2 === 1 ? ' br-wheel__bulb--odd' : ''}`}
          />
        );
      })}
    </>
  );
});

/**
 * FR-10 genre roulette. The result is already in the snapshot; the animation
 * only derives its rotation from the shared phase clock, so a late mount, a
 * reload or a pause freezes on the same angle instead of rerolling.
 *
 * Timeline (`wheelTimeline`): the disc eases over 2580 ms (`ease-wheel`), the
 * pointer flicks for 140 ms at every segment it passes, and at the stop the
 * stage shakes for 420 ms while the genre plate pops in, all inside the phase
 * length. Fixed mode shows the plate straight away. Reduced motion: no spin,
 * no shake, the wheel stands on the target and the plate fades in at once.
 */
export function GenreSpin({ session, state }: GenreSpinProps) {
  const { t, i18n } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const room = selectRoom(state);
  const genrePool = state.genrePool;
  // The selector clones the pool; key the copy on the pool identity so the
  // memoised wheel face only rebuilds when the pool itself changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- genrePool is the identity of `state`'s pool
  const pool = useMemo(() => selectGenrePool(state), [genrePool]);
  const genre = room.genre;
  const spinMode = selectSettings(state).genreMode !== 'fixed';
  const now = useSessionNow(session, spinMode && !reducedMotion, FRAME_MS);
  const timer = selectPhaseTimer(state, now);

  const totalMs = timer.totalMs ?? 0;
  const elapsed =
    timer.totalMs !== null && timer.remainingMs !== null
      ? timer.totalMs - timer.remainingMs
      : Number.POSITIVE_INFINITY;
  const { spinMs, shakeMs } = wheelTimeline(totalMs);
  const stopped = !spinMode || reducedMotion || elapsed >= spinMs;

  // The polite live region mounts empty and receives the result in a later
  // task, so it is an update (announced) even when the wheel is already
  // stopped on the first render (fixed mode, reduced motion). Only `stopped`
  // and the text are dependencies: clock frames and pause/resume re-render
  // without changing them, so the text is published once per result.
  const announcementText = genre
    ? t('genre.announcement', {
        genre: genreName(genre, i18n.resolvedLanguage),
      })
    : '';
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (!stopped) {
      return undefined;
    }
    const handle = setTimeout(() => setAnnounced(announcementText), 0);
    return () => clearTimeout(handle);
  }, [stopped, announcementText]);

  if (!genre) {
    return null;
  }
  const label = genreName(genre, i18n.resolvedLanguage);
  const index = pool.findIndex((candidate) => candidate.id === genre.id);
  const targetAngle = genreTargetAngle(index, pool.length);
  const rotation = reducedMotion
    ? targetAngle
    : wheelAngle(elapsed, spinMs, targetAngle);
  const ticks = wheelTicks(rotation, pool.length);
  const ticking =
    !reducedMotion && ticks > 0 && elapsed < spinMs + POINTER_TICK_MS;
  const shaking =
    spinMode &&
    !reducedMotion &&
    shakeMs > 0 &&
    elapsed >= spinMs &&
    elapsed < spinMs + shakeMs;

  return (
    <section data-testid="genre-spin" className="br-spin">
      <h2 className="br-panel__title">{t('genre.heading')}</h2>

      <div
        className={`br-spin__stage${shaking ? ' br-shake' : ''}`}
        style={
          shaking
            ? {
                animationDuration: `${shakeMs}ms`,
                animationDelay: `${spinMs - elapsed}ms`,
              }
            : undefined
        }
      >
        {spinMode ? (
          <>
            <div className="br-wheel">
              <div
                key={ticking ? ticks : 'idle'}
                aria-hidden="true"
                className={`br-wheel__pointer${ticking ? ' is-tick' : ''}`}
              />
              <svg
                data-testid="genre-wheel"
                data-genre-id={genre.id}
                data-target-angle={Math.round(targetAngle)}
                viewBox="-160 -160 320 320"
                role="img"
                aria-label={
                  stopped
                    ? t('genre.announcement', { genre: label })
                    : t('genre.spinning')
                }
                className="br-wheel__disc"
                style={{ transform: `rotate(${rotation}deg)` }}
              >
                <WheelFace pool={pool} language={i18n.resolvedLanguage} />
              </svg>
              <div aria-hidden="true" className="br-wheel__hub" />
            </div>
            {!stopped && <p className="br-label">{t('genre.spinning')}</p>}
          </>
        ) : (
          <p data-testid="genre-fixed-notice" className="br-read">
            {t('genre.fixedNotice')}
          </p>
        )}

        <div className="br-spin__slot">
          {stopped && (
            <GenrePlate
              kicker={spinMode ? t('genre.kicker') : t('genre.resultLabel')}
              name={label}
              live={false}
            />
          )}
        </div>
      </div>

      <span data-testid="genre-result" className="sr-only">
        {label}
      </span>
      <span
        data-testid="genre-announcement"
        aria-live="polite"
        className="sr-only"
      >
        {stopped && announced === announcementText ? announced : ''}
      </span>
    </section>
  );
}
