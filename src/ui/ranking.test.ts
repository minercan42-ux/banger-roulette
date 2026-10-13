import { describe, expect, it } from 'vitest';
import {
  appendToRanking,
  insertRanking,
  moveRanking,
  removeFromRanking,
  reorderRanking,
} from './ranking';

describe('appendToRanking', () => {
  it('appends as the next place', () => {
    expect(appendToRanking(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op copy for an already ranked song', () => {
    const ranking = ['a', 'b'];
    const next = appendToRanking(ranking, 'a');
    expect(next).toEqual(['a', 'b']);
    expect(next).not.toBe(ranking);
  });
});

describe('insertRanking', () => {
  it('inserts at the requested place', () => {
    expect(insertRanking(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
  });

  it('clamps below zero to the first place', () => {
    expect(insertRanking(['b'], 'a', -5)).toEqual(['a', 'b']);
  });

  it('clamps beyond the end to the last place', () => {
    expect(insertRanking(['a'], 'b', 99)).toEqual(['a', 'b']);
  });

  it('is a no-op copy when the song is already ranked', () => {
    const ranking = ['a', 'b'];
    const next = insertRanking(ranking, 'a', 0);
    expect(next).toEqual(['a', 'b']);
    expect(next).not.toBe(ranking);
  });
});

describe('removeFromRanking', () => {
  it('drops the song while keeping the order of the rest', () => {
    expect(removeFromRanking(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('is a no-op copy for an unranked song', () => {
    const ranking = ['a', 'b'];
    const next = removeFromRanking(ranking, 'z');
    expect(next).toEqual(['a', 'b']);
    expect(next).not.toBe(ranking);
  });
});

describe('reorderRanking', () => {
  it('moves a song down to the target place', () => {
    expect(reorderRanking(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves a song up to the target place', () => {
    expect(reorderRanking(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the same order when the place is unchanged', () => {
    expect(reorderRanking(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
  });

  it('clamps the target to the list bounds', () => {
    expect(reorderRanking(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(reorderRanking(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op copy for an unknown song', () => {
    const ranking = ['a', 'b'];
    const next = reorderRanking(ranking, 'z', 0);
    expect(next).toEqual(['a', 'b']);
    expect(next).not.toBe(ranking);
  });
});

describe('moveRanking', () => {
  it('swaps with the neighbour above and below', () => {
    expect(moveRanking(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveRanking(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('does not move past the first or last place', () => {
    expect(moveRanking(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(moveRanking(['a', 'b'], 'b', 1)).toEqual(['a', 'b']);
  });
});
