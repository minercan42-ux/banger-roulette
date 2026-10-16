import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  dispatch,
  snapshot,
  stateOf,
  unlockSound,
  waitForPhase,
} from './m3-support';

/**
 * Shared rating drivers for the M5 game suite. `playToReveal`/`ratePlayback`
 * (and the `mediaFor` fixture) used to live privately in `lobby.spec.ts`; they
 * are exported here so the lobby suite and the M5 suite drive the same single
 * copy instead of diverging.
 *
 * Everything goes through the real `GameSession`/engine over the WS bridge; the
 * UI is only exercised by the callers that need it.
 */

/** Deterministic 11-char videoId fixture shared by the lobby and M5 suites. */
export function mediaFor(round: number, index: number): Media {
  // Nine-character base plus two digits keeps every videoId exactly 11 chars.
  const videoId = `dQw4w9WgX${round}${index}`;
  return {
    videoId,
    title: `Song ${round}-${index}`,
    channel: `Channel ${index}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: 200,
    startSeconds: 0,
  };
}

/**
 * Unlocks sound everywhere, starts the game, submits and finishes one song per
 * player, and returns once every submission is in. The resulting phase is the
 * caller's to decide: PLAYBACK for a normal round, REVEAL for the degenerate
 * zero/one-song cases (FR-54).
 */
export async function submitSongsAndFinish(
  players: Page[],
  medias: readonly Media[],
): Promise<void> {
  const [host, ...rest] = players;
  for (const player of players) {
    await unlockSound(player);
  }
  expect((await dispatch(host, { type: 'START_GAME' })).status).toBe(
    'accepted',
  );
  await waitForPhase(host, 'GENRE_SPIN');
  expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
  await waitForPhase(host, 'SUBMISSION');
  await Promise.all(rest.map((player) => waitForPhase(player, 'SUBMISSION')));
  for (const [index, player] of players.entries()) {
    expect(
      (await dispatch(player, { type: 'SUBMIT_SONG', media: medias[index] }))
        .status,
    ).toBe('accepted');
    expect((await dispatch(player, { type: 'FINISH_SUBMISSION' })).status).toBe(
      'accepted',
    );
  }
}

/** Submits one song per player through the session and lands on PLAYBACK. */
export async function playToPlayback(
  players: Page[],
  medias: readonly Media[],
): Promise<void> {
  const [host] = players;
  await submitSongsAndFinish(players, medias);
  await waitForPhase(host as Page, 'PLAYBACK');
}

/** What `rater` gives `song` (both indexes into `players`/`medias`); `null` skips it. */
export type RatingFn = (rater: number, song: number) => number | null;

/** Every rater gives every foreign song a 5. */
export const FLAT_RATING: RatingFn = () => 5;

/**
 * Rates the song that is playing right now through the session (FR-40): every
 * player that does not own it dispatches `RATE` when `value` yields a number.
 * Returns the song's index in `medias`.
 */
export async function rateCurrentSong(
  players: Page[],
  medias: readonly Media[],
  value: RatingFn,
): Promise<number> {
  const [host] = players;
  const state = await stateOf(host as Page);
  const round = state?.round;
  const phase = state?.phase;
  if (!round || phase?.type !== 'PLAYBACK') {
    throw new Error('rateCurrentSong needs the PLAYBACK phase');
  }
  const videoId = round.playbackOrder[phase.index] as string;
  const songIndex = medias.findIndex((media) => media.videoId === videoId);
  const song = round.songs.find(
    (candidate) => candidate.media.videoId === videoId,
  );
  for (const [raterIndex, page] of players.entries()) {
    const raterId = (await snapshot(page)).clientId;
    const given = value(raterIndex, songIndex);
    if (given === null || song?.ownerIds.includes(raterId)) {
      continue;
    }
    expect(
      (await dispatch(page, { type: 'RATE', songId: videoId, value: given }))
        .status,
    ).toBe('accepted');
  }
  return songIndex;
}

/** Skips every playback clip (no ratings) and waits for REVEAL on every client. */
export async function advanceToReveal(players: Page[]): Promise<void> {
  const [host, ...rest] = players;
  const songs = (await stateOf(host))?.round?.songs.length ?? 0;
  for (let index = 0; index < songs; index += 1) {
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
  }
  await waitForPhase(host, 'REVEAL');
  await Promise.all(rest.map((player) => waitForPhase(player, 'REVEAL')));
}

/**
 * Rates each remaining playing song with `value`, skips its clip with the host
 * `ADVANCE` and waits for REVEAL on every client. Safe to call mid-PLAYBACK.
 */
export async function ratePlayback(
  players: Page[],
  medias: readonly Media[],
  value: RatingFn = FLAT_RATING,
): Promise<void> {
  const [host, ...rest] = players;
  while ((await stateOf(host as Page))?.phase.type === 'PLAYBACK') {
    await rateCurrentSong(players, medias, value);
    expect((await dispatch(host as Page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
  }
  await waitForPhase(host as Page, 'REVEAL');
  await Promise.all(rest.map((player) => waitForPhase(player, 'REVEAL')));
}

/** Plays one full round (every foreign song rated 5 unless told otherwise) up to REVEAL. */
export async function playToReveal(
  players: Page[],
  round: number,
  value: RatingFn = FLAT_RATING,
): Promise<Media[]> {
  const medias = players.map((_, index) => mediaFor(round, index));
  await playToPlayback(players, medias);
  await ratePlayback(players, medias, value);
  return medias;
}
