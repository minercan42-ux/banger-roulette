import { describe, expect, it } from 'vitest';
import { drawGenre, nextRandom, nextUint32, shuffle } from './rng';
import { genre } from './fixtures';

describe('xorshift32', () => {
  it('matches the canonical step and never returns zero for seed 1', () => {
    expect(nextUint32(1)).toBe(270369);
    let state = 1;
    for (let step = 0; step < 1000; step += 1) {
      state = nextUint32(state);
      expect(state).not.toBe(0);
    }
  });

  it('is deterministic and stays inside the uint32 domain', () => {
    const first = nextRandom(12345);
    expect(nextRandom(12345)).toEqual(first);
    expect(first.rngState).toBeGreaterThanOrEqual(1);
    expect(first.rngState).toBeLessThanOrEqual(0xffffffff);
    expect(first.value).toBeGreaterThanOrEqual(0);
    expect(first.value).toBeLessThan(1);
  });
});

describe('shuffle', () => {
  it('is a deterministic permutation that leaves the input alone', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const first = shuffle(items, 7);
    expect(first.items).toHaveLength(items.length);
    expect([...first.items].sort()).toEqual([...items].sort());
    expect(shuffle(items, 7)).toEqual(first);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves a single item untouched and consumes no state', () => {
    expect(shuffle(['a'], 7)).toEqual({ items: ['a'], rngState: 7 });
  });
});

describe('drawGenre', () => {
  it('draws without repetition and refills an exhausted cycle', () => {
    const pool = [genre(1), genre(2), genre(3)];
    const first = drawGenre(
      pool,
      pool.map((entry) => entry.id),
      99,
    );
    expect(first.remainingGenreIds).toHaveLength(2);
    expect(first.remainingGenreIds).not.toContain(first.genre.id);
    const second = drawGenre(pool, first.remainingGenreIds, first.rngState);
    expect(second.genre.id).not.toBe(first.genre.id);
    const third = drawGenre(pool, second.remainingGenreIds, second.rngState);
    expect(
      new Set([first.genre.id, second.genre.id, third.genre.id]).size,
    ).toBe(3);
    expect(third.remainingGenreIds).toHaveLength(0);
    const refill = drawGenre(pool, third.remainingGenreIds, third.rngState);
    expect(pool.map((entry) => entry.id)).toContain(refill.genre.id);
    expect(refill.remainingGenreIds).toHaveLength(2);
  });

  it('rejects an empty pool', () => {
    expect(() => drawGenre([], [], 1)).toThrow();
  });
});
