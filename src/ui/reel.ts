/**
 * Pure maths of the genre reel (FR-10): a drum seen from the side whose rows
 * are the pool's genres. Everything is a function of server-synced time and
 * the shared pool, so every client animates the same path and stops on the
 * same genre (AK-1).
 */

/** Drum angle between two neighbouring rows, in degrees (`--reel-row-deg`). */
export const REEL_ROW_DEG = 26;
/** Rows the drum travels at least before it stops; pool sizes only round up. */
export const REEL_MIN_ROWS = 28;

/** Spin path length with deceleration; the stylesheet's `--dur-spin`. */
export const REEL_SPIN_MS = 3200;
/** Shake at the stop; `.br-shake` lasts 420 ms. */
export const REEL_SHAKE_MS = 420;
/** Pointer nudge per passed row; `.br-reel__pointer.is-tick`. */
export const REEL_TICK_MS = 140;
/**
 * The result stays on screen at least this long after the stop. The engine's
 * `SPIN_MS` (5500) is `REEL_SPIN_MS` plus this hold plus slack.
 */
export const REEL_HOLD_MS = 2000;

/** Genre rows rendered around the centre; |d| < 4 rows is the visible half drum. */
export const REEL_VISIBLE_ROWS = 8;

/**
 * Deterministic final drum angle, in degrees, for the genre at `index` of the
 * pool. Row `k` of the endless drum shows `pool[k mod count]`, so the stop row
 * is the first one at or past `REEL_MIN_ROWS` that is that genre.
 */
export function genreTargetAngle(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  const safeIndex = index < 0 ? 0 : index % count;
  const rows = count * Math.ceil(REEL_MIN_ROWS / count) + safeIndex;
  return rows * REEL_ROW_DEG;
}

/**
 * Deceleration as a pure function of linear progress `x` in [0, 1]: a cubic
 * ease-out. Rises from 0 to exactly 1 and its speed never increases.
 */
export function reelEase(x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const rest = 1 - x;
  return 1 - rest * rest * rest;
}

export interface ReelTimeline {
  /** Length of the spin path. */
  spinMs: number;
  /** Shake right after the stop. */
  shakeMs: number;
}

/**
 * Split the genre phase into spin and shake. The phase length (`SPIN_MS` in
 * the engine) is authoritative: when spin plus shake do not fit, the shake
 * shrinks first and the spin only compresses once the phase is shorter than
 * the spin itself. The end angle is the target either way.
 */
export function reelTimeline(totalMs: number): ReelTimeline {
  const total = Math.max(0, totalMs);
  const spinMs = Math.min(REEL_SPIN_MS, total);
  const shakeMs = Math.min(REEL_SHAKE_MS, total - spinMs);
  return { spinMs, shakeMs };
}

/**
 * Drum rotation in degrees `elapsedMs` after the phase started. A pure
 * function of the shared clock: late mounts, reloads and pauses land on the
 * same angle, and from `spinMs` on it is exactly `targetAngle`.
 */
export function reelAngle(
  elapsedMs: number,
  spinMs: number,
  targetAngle: number,
): number {
  if (spinMs <= 0 || elapsedMs >= spinMs) {
    return targetAngle;
  }
  return targetAngle * reelEase(elapsedMs / spinMs);
}

/** Rows that have passed the selection window at `angle`; one tick each. */
export function reelTicks(angle: number): number {
  return angle <= 0 ? 0 : Math.floor(angle / REEL_ROW_DEG);
}

export interface ReelRow {
  /** Stable DOM slot, so rows are reused instead of remounted per pass. */
  slot: number;
  /** Pool index shown by this row. */
  poolIndex: number;
  /** Rows between this one and the selection window, negative above. */
  offset: number;
  /** Drum angle of the row relative to the window, in degrees. */
  degrees: number;
}

/**
 * The rows of the endless drum that are on its visible half at `angle`.
 * Row `k` shows `pool[k mod count]`; the one nearest the window is at offset
 * 0 when the drum stands on a row.
 */
export function reelRows(angle: number, count: number): ReelRow[] {
  if (count <= 0) {
    return [];
  }
  const position = angle / REEL_ROW_DEG;
  const first = Math.floor(position) - REEL_VISIBLE_ROWS / 2 + 1;
  const rows: ReelRow[] = [];
  for (let step = 0; step < REEL_VISIBLE_ROWS; step += 1) {
    const row = first + step;
    const offset = row - position;
    rows.push({
      slot: ((row % REEL_VISIBLE_ROWS) + REEL_VISIBLE_ROWS) % REEL_VISIBLE_ROWS,
      poolIndex: ((row % count) + count) % count,
      offset,
      degrees: offset * REEL_ROW_DEG,
    });
  }
  return rows;
}
