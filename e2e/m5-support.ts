import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import { dispatch, stateOf, unlockSound, waitForPhase } from './m3-support';

/**
 * Shared voting drivers for the M5 game suite. `playToVoting`/`finishVoting`
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

/** Skips every playback clip and waits for VOTING on every client. */
export async function advanceToVoting(players: Page[]): Promise<void> {
  const [host, ...rest] = players;
  const songs = (await stateOf(host))?.round?.songs.length ?? 0;
  for (let index = 0; index < songs; index += 1) {
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
  }
  await waitForPhase(host, 'VOTING');
  await Promise.all(rest.map((player) => waitForPhase(player, 'VOTING')));
}

/** Plays one full round up to the VOTING phase through the real session. */
export async function playToVoting(
  players: Page[],
  round: number,
): Promise<Media[]> {
  const medias = players.map((_, index) => mediaFor(round, index));
  await playToPlayback(players, medias);
  await advanceToVoting(players);
  return medias;
}

/** Every player ranks every foreign song and finishes voting. */
export async function finishVoting(
  players: Page[],
  medias: Media[],
): Promise<void> {
  for (const [index, player] of players.entries()) {
    const ranking = medias
      .filter((_, songIndex) => songIndex !== index)
      .map((media) => media.videoId);
    expect(
      (await dispatch(player, { type: 'SET_RANKING', ranking })).status,
    ).toBe('accepted');
    expect((await dispatch(player, { type: 'FINISH_VOTING' })).status).toBe(
      'accepted',
    );
  }
}
