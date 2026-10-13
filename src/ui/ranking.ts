/**
 * Pure helpers for the FR-40 voting ranking. The ranking is a list of video ids
 * in place order (index 0 = place 1). All helpers return a new array and never
 * mutate the input, so they are trivial to unit test and safe for React state.
 */

/** Appends a song as the next place; no-op (copy) when it is already ranked. */
export function appendToRanking(
  ranking: readonly string[],
  videoId: string,
): string[] {
  if (ranking.includes(videoId)) {
    return [...ranking];
  }
  return [...ranking, videoId];
}

/** Inserts an unranked song at `index`; no-op (copy) when already ranked. */
export function insertRanking(
  ranking: readonly string[],
  videoId: string,
  index: number,
): string[] {
  if (ranking.includes(videoId)) {
    return [...ranking];
  }
  const next = [...ranking];
  const at = Math.min(Math.max(Math.trunc(index), 0), next.length);
  next.splice(at, 0, videoId);
  return next;
}

/** Drops a song back into the pool; no-op (copy) when it is not ranked. */
export function removeFromRanking(
  ranking: readonly string[],
  videoId: string,
): string[] {
  return ranking.filter((id) => id !== videoId);
}

/**
 * Moves a ranked song to `toIndex` in the resulting array (remove-then-insert).
 * Unknown ids or an unchanged position return an equal-length copy.
 */
export function reorderRanking(
  ranking: readonly string[],
  videoId: string,
  toIndex: number,
): string[] {
  const from = ranking.indexOf(videoId);
  if (from === -1) {
    return [...ranking];
  }
  const next = [...ranking];
  next.splice(from, 1);
  const at = Math.min(Math.max(Math.trunc(toIndex), 0), next.length);
  next.splice(at, 0, videoId);
  return next;
}

/** Moves a ranked song by `delta` places, clamped to the list bounds. */
export function moveRanking(
  ranking: readonly string[],
  videoId: string,
  delta: number,
): string[] {
  const from = ranking.indexOf(videoId);
  if (from === -1) {
    return [...ranking];
  }
  return reorderRanking(ranking, videoId, from + delta);
}
