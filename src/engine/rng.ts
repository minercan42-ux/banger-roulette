import type { Genre } from '../shared/primitives';

/** 2^32 as a divisor for mapping uint32 state onto the half-open unit interval. */
const UINT32_RANGE = 0x100000000;

/**
 * One xorshift32 step. Pure and deterministic: the returned value only depends
 * on the injected state, never on a clock or the host RNG.
 */
export function nextUint32(state: number): number {
  let x = state >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export interface RandomStep {
  rngState: number;
  /** Uniform value in [0, 1). */
  value: number;
}

export function nextRandom(state: number): RandomStep {
  const rngState = nextUint32(state);
  return { rngState, value: rngState / UINT32_RANGE };
}

export interface ShuffleResult<T> {
  items: T[];
  rngState: number;
}

/** Fisher-Yates shuffle driven exclusively by the injected RNG state. */
export function shuffle<T>(
  items: readonly T[],
  rngState: number,
): ShuffleResult<T> {
  const out = items.slice();
  let state = rngState;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const step = nextRandom(state);
    state = step.rngState;
    const j = Math.floor(step.value * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return { items: out, rngState: state };
}

export interface GenreDraw {
  genre: Genre;
  remainingGenreIds: string[];
  rngState: number;
}

/**
 * Draws the next genre from the non-repeating cycle. An exhausted cycle is
 * refilled with the whole pool before drawing (FR-11).
 */
export function drawGenre(
  pool: readonly Genre[],
  remainingGenreIds: readonly string[],
  rngState: number,
): GenreDraw {
  if (pool.length === 0) {
    throw new Error('Genre pool must not be empty');
  }
  const remaining =
    remainingGenreIds.length > 0
      ? [...remainingGenreIds]
      : pool.map((genre) => genre.id);
  const step = nextRandom(rngState);
  const index = Math.min(
    remaining.length - 1,
    Math.floor(step.value * remaining.length),
  );
  const genreId = remaining[index];
  const genre = pool.find((candidate) => candidate.id === genreId) ?? pool[0];
  return {
    genre,
    remainingGenreIds: remaining.filter((_, position) => position !== index),
    rngState: step.rngState,
  };
}
