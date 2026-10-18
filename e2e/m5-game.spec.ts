import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  dispatch,
  enterSubmission,
  newStage,
  setSettings,
  snapshot,
  stateOf,
  submitSongViaUi,
  unlockSound,
  waitForPhase,
  type Stage,
} from './m3-support';
import {
  mediaFor,
  playToPlayback,
  rateCurrentSong,
  ratePlayback,
  type RatingFn,
} from './m5-support';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';

/**
 * M5 consumer coverage: the first completely playable game. Live 0-10 rating
 * (FR-40..42), genre-fail (FR-34/41/52), scoring (FR-50..54) and
 * reveal/leaderboard/finale (FR-60..62) are driven through the real UI on top
 * of the real `GameSession` and engine; only the external YouTube edge is
 * replaced by the fixture.
 *
 * The rating/reveal/final assertions target the documented data-testid
 * contract (`rating-bar`, `rating-chip-<n>`, `rating-summary`, ...). Phase
 * timing is skipped with the host `ADVANCE` where it is irrelevant, so every
 * scenario is deterministic and fully-parallel safe.
 */

const SONG_A = 'm5songA0001';
const SONG_B = 'm5songB0002';
const SONG_C = 'm5songC0003';
const SONG_D = 'm5songD0004';
const DUP = 'm5dupe00001';
const OTHER = 'm5other0002';
const PART_A = 'm5partA0001';
const PART_B = 'm5partB0002';
const PART_C = 'm5partC0003';

function mediaOf(videoId: string, startSeconds = 0): Media {
  return {
    videoId,
    title: fixtureTitle(videoId),
    channel: FIXTURE_CHANNEL,
    thumbnail: fixtureThumbnail(videoId),
    durationSeconds: 200,
    startSeconds,
  };
}

/** `values[rater][song]`: what each player gives each song; `null` = none. */
type RatingMatrix = ReadonlyArray<ReadonlyArray<number | null>>;

async function playerId(page: Page): Promise<string> {
  return (await snapshot(page)).clientId;
}

async function ratingOf(
  page: Page,
  id: string,
  videoId: string,
): Promise<number | undefined> {
  const state = await stateOf(page);
  return state?.round?.ratings?.[id]?.[videoId];
}

/** Clicks one chip of the playing song's bar and waits for it to be pressed. */
async function rateByUi(page: Page, value: number): Promise<void> {
  const chip = page.getByTestId(`rating-chip-${value}`);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Rates a chip of the playing song's bar with the keyboard (AK-2, #153).
 * Firefox needs up to a second between the mouse down and up of a pointer
 * click on a loaded runner, and the PLAYBACK panel reflows in that window
 * while its notices come and go (the 54 px pause notice of `PhaseNotices`,
 * the 34 px preroll notice), so the click can land beside the 44 px chip and
 * never rate. Focus and Enter need no coordinates: the same remedy
 * `pressFertig` uses (#140/#151), and how `e2e/a11y.spec.ts` drives the chips.
 */
async function rateByChipKey(page: Page, value: number): Promise<void> {
  const chip = page.getByTestId(`rating-chip-${value}`);
  await chip.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Moves PLAYBACK to the song with `videoId` with the host `ADVANCE` (the clips
 * themselves are not under test) and waits until every page renders it. Songs
 * that are skipped on the way are rated with `rating`, so they still score.
 */
async function advanceToSong(
  pages: Page[],
  videoId: string,
  rating?: { medias: readonly Media[]; value: RatingFn },
): Promise<void> {
  const [host] = pages as [Page];
  for (let guard = 0; guard < 12; guard += 1) {
    const state = await stateOf(host);
    if (state?.phase.type !== 'PLAYBACK') {
      throw new Error(`PLAYBACK ended before ${videoId} played`);
    }
    if (state.round?.playbackOrder[state.phase.index] === videoId) {
      for (const page of pages) {
        await expect(page.getByTestId('playback-phase')).toHaveAttribute(
          'data-index',
          String(state.phase.index),
        );
      }
      return;
    }
    if (rating !== undefined) {
      await rateCurrentSong(pages, rating.medias, rating.value);
    }
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
  }
  throw new Error(`Song ${videoId} never became the current song`);
}

/**
 * Plays every song of the round. Player `uiRater` rates through the visible
 * chip bar, everybody else through the session; the host skips each clip.
 */
async function ratePlaybackWithUi(
  stages: readonly Stage[],
  medias: readonly Media[],
  values: RatingMatrix,
  uiRater = 0,
): Promise<void> {
  const pages = stages.map((stage) => stage.page);
  const [host, ...rest] = pages as [Page, ...Page[]];
  for (;;) {
    const state = await stateOf(host);
    if (state?.phase.type !== 'PLAYBACK') {
      break;
    }
    const playing = state.phase.index;
    await expect(pages[uiRater]!.getByTestId('playback-phase')).toHaveAttribute(
      'data-index',
      String(playing),
    );
    const songIndex = await rateCurrentSong(pages, medias, (rater, song) =>
      rater === uiRater ? null : (values[rater]?.[song] ?? null),
    );
    const given = values[uiRater]?.[songIndex] ?? null;
    if (given !== null) {
      await rateByUi(pages[uiRater]!, given);
    }
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
  }
  await waitForPhase(host, 'REVEAL');
  await Promise.all(rest.map((page) => waitForPhase(page, 'REVEAL')));
}

interface RevealEntry {
  videoId: string;
  winner: boolean;
  genreFailed: boolean;
  banger: boolean;
  owners: string;
  points: string;
}

async function revealEntries(page: Page): Promise<RevealEntry[]> {
  return page.locator('[data-testid="reveal-entry"]').evaluateAll((elements) =>
    elements.map((element) => ({
      videoId: element.getAttribute('data-video-id') ?? '',
      winner: element.getAttribute('data-winner') === 'true',
      genreFailed: element.getAttribute('data-genre-failed') === 'true',
      banger: element.getAttribute('data-banger') === 'true',
      owners:
        element
          .querySelector('[data-testid="reveal-entry-owners"]')
          ?.textContent?.trim() ?? '',
      points:
        element
          .querySelector('[data-testid="reveal-entry-points"]')
          ?.textContent?.trim() ?? '',
    })),
  );
}

/**
 * FR-60 reveals worst-first against server time (2500 ms per entry, 5000 ms for
 * a banger), so the full list (and the leaderboard) only appears after the last
 * entry's revealAt.
 */
async function waitForFullReveal(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('reveal-entry')).toHaveCount(count, {
    timeout: count * 2500 + 15_000,
  });
  await expect(page.getByTestId('leaderboard')).toBeVisible();
}

async function rankedRowMap(
  page: Page,
  testId: string,
): Promise<Record<string, string>> {
  const rows = await page
    .locator(`[data-testid="${testId}"]`)
    .evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute('data-player-id') ?? '',
        rank: element.getAttribute('data-rank') ?? '',
      })),
    );
  return Object.fromEntries(rows.map((row) => [row.id, row.rank]));
}

function entryOf(page: Page, videoId: string) {
  return page.locator(
    `[data-testid="reveal-entry"][data-video-id="${videoId}"]`,
  );
}

test('full game: rating, scoring, reveal, leaderboard and rematch', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    // Only the host's count-up is asserted, so the other three screens play in
    // reduced motion. Four screens painting the 5 s banger show at once left
    // the host's frame clock too slow on a shared CI runner (headless WebKit,
    // two tests in parallel): the winner's count-up had not reached its total
    // when the reveal ended. The reduced-motion show is a static card.
    newStage(browser, { nickname: 'Bob', reducedMotion: 'reduce' }),
    newStage(browser, { nickname: 'Cara', reducedMotion: 'reduce' }),
    newStage(browser, { nickname: 'Dana', reducedMotion: 'reduce' }),
  ]);
  try {
    const [host, bob] = stages as [Stage, Stage, Stage, Stage];
    const all = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await setSettings(host.page, { rounds: 1 });
    await enterSubmission(all);
    // The submission panel carries the countdown stat (NFR-02: client-side).
    const submissionTimer = host.page
      .getByTestId('submission-panel')
      .getByTestId('phase-timer');
    await expect(submissionTimer).toHaveAttribute('role', 'timer');
    await expect(submissionTimer).toHaveText(/\d+:\d{2}/);
    await expect(host.page.getByTestId('phase-timer')).toHaveCount(1);

    // Every player submits a distinct song through the visible submission flow.
    const songs = [SONG_A, SONG_B, SONG_C, SONG_D];
    const urls = songs.map((id) => `https://www.youtube.com/watch?v=${id}`);
    for (const [index, page] of all.entries()) {
      await submitSongViaUi(page, urls[index]!);
      await page.getByTestId('finish-submission').click();
    }
    await waitForPhase(host.page, 'PLAYBACK');
    await Promise.all(all.map((page) => waitForPhase(page, 'PLAYBACK')));
    await expect(host.page.getByTestId('playback-timer')).toHaveAttribute(
      'role',
      'timer',
    );
    await expect(host.page.getByTestId('playback-progress')).toHaveAttribute(
      'role',
      'progressbar',
    );

    const [aId, bId, cId, dId] = await Promise.all(all.map(playerId));
    const owner = new Map(
      ((await stateOf(host.page))?.round?.songs ?? []).map((song) => [
        song.media.videoId,
        song.ownerIds[0] ?? '',
      ]),
    );
    expect(owner.get(SONG_A)).toBe(aId);
    expect(owner.get(SONG_C)).toBe(cId);

    // The chip bar under the playing song: the genre-fail chip plus 1..10
    // (11 round chips), the owner sees "your song" instead; nothing is rated
    // or summarised yet.
    const firstSong = (await stateOf(host.page))?.round?.playbackOrder[0] ?? '';
    for (const [index, stage] of stages.entries()) {
      const ownsIt = owner.get(firstSong) === [aId, bId, cId, dId][index];
      await expect(stage.page.getByTestId('rating-bar')).toHaveCount(
        ownsIt ? 0 : 1,
      );
      await expect(stage.page.getByTestId('rating-own')).toHaveCount(
        ownsIt ? 1 : 0,
      );
      if (!ownsIt) {
        await expect(
          stage.page.locator('[data-testid^="rating-chip-"]'),
        ).toHaveCount(11);
        await expect(stage.page.getByTestId('rating-chip-0')).toHaveAttribute(
          'data-kind',
          'genre-fail',
        );
      }
      await expect(stage.page.getByTestId('rating-summary')).toHaveCount(0);
    }

    // Ratings [rater][song]: A 7.3 (7,8,7), B 4.7 (5,5,4), D 2.7 (3,3,2) and
    // Cara's song C is a banger (all 10). Alice rates through the UI.
    const values: RatingMatrix = [
      [null, 5, 10, 3],
      [7, null, 10, 3],
      [8, 5, null, 2],
      [7, 4, 10, null],
    ];
    await ratePlaybackWithUi(
      stages,
      songs.map((id) => mediaOf(id)),
      values,
    );

    // Alice's own ratings, as stored by the engine.
    const hostRatings = (await stateOf(host.page))?.round?.ratings[aId!];
    expect(hostRatings).toEqual({
      [SONG_B]: 5,
      [SONG_C]: 10,
      [SONG_D]: 3,
    });
    await waitForFullReveal(host.page, 4);
    // The counted-up combo settles on the engine's numbers: average + bonus = score.
    for (const [videoId, average, bonus, total] of [
      [SONG_D, '2.7', '0.0', '2.7'],
      [SONG_B, '4.7', '0.0', '4.7'],
      [SONG_A, '7.3', '0.0', '7.3'],
      [SONG_C, '10.0', '2.0', '12.0'],
    ] as const) {
      const combo = entryOf(host.page, videoId).getByTestId('score-combo');
      await expect(combo.getByTestId('score-combo-votes')).toHaveText(average, {
        timeout: 5_000,
      });
      await expect(combo.getByTestId('score-combo-adjust')).toHaveText(bonus);
      await expect(combo.getByTestId('score-combo-total')).toHaveText(total);
    }

    const entries = await revealEntries(host.page);
    // Ascending score: D 2.7, B 4.7, A 7.3, C 10.0 + 2.0 bonus = 12.0.
    expect(entries.map((entry) => entry.videoId)).toEqual([
      SONG_D,
      SONG_B,
      SONG_A,
      SONG_C,
    ]);
    const byVideo = Object.fromEntries(entries.map((e) => [e.videoId, e]));
    expect(byVideo[SONG_C]?.winner).toBe(true);
    expect(byVideo[SONG_C]?.banger).toBe(true);
    expect(byVideo[SONG_A]?.banger).toBe(false);
    expect(byVideo[SONG_C]?.points).toContain('12.0');
    expect(byVideo[SONG_A]?.points).toContain('7.3');
    expect(byVideo[SONG_B]?.points).toContain('4.7');
    expect(byVideo[SONG_D]?.points).toContain('2.7');
    expect(byVideo[SONG_A]?.points).toMatch(/3 ratings|3 Bewertungen/);
    expect(entries.filter((entry) => entry.genreFailed)).toEqual([]);
    await expect(host.page.getByTestId('reveal-entry-banger')).toHaveCount(1);
    await expect(
      entryOf(host.page, SONG_C).getByTestId('reveal-entry-banger'),
    ).toBeVisible();
    await expect(
      entryOf(host.page, SONG_A).getByTestId('reveal-entry-rating'),
    ).toContainText('7.3');
    await expect(host.page.getByTestId('reveal-jackpot')).toHaveCount(1);
    await expect(
      entryOf(host.page, SONG_C).getByTestId('reveal-jackpot'),
    ).toHaveCount(1);

    // Scoring matches the engine's own result, not just the rendered text.
    const revealed = await stateOf(host.page);
    const result = revealed?.results[0];
    expect(result?.reason).toBe('normal');
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    expect(scored.get(SONG_C)).toMatchObject({
      scoreTenths: 100,
      ratingCount: 3,
      banger: true,
      bonus: 20,
      winner: true,
      basis: 'ratings',
    });
    expect(scored.get(SONG_A)).toMatchObject({ scoreTenths: 73 });
    expect(scored.get(SONG_B)).toMatchObject({ scoreTenths: 47 });
    expect(scored.get(SONG_D)).toMatchObject({ scoreTenths: 27 });
    expect(scored.get(SONG_C)?.ownerDeltas[cId!]).toBe(120);
    expect(scored.get(SONG_A)?.ownerDeltas[aId!]).toBe(73);

    // Interim leaderboard ranks mirror the round totals (shown with one decimal).
    const ranks = await rankedRowMap(host.page, 'leaderboard-row');
    expect(ranks[cId!]).toBe('1');
    expect(ranks[aId!]).toBe('2');
    expect(ranks[bId!]).toBe('3');
    expect(ranks[dId!]).toBe('4');
    const cRow = host.page.locator(
      `[data-testid="leaderboard-row"][data-player-id="${cId}"]`,
    );
    await expect(cRow).toContainText('12.0');
    await expect(cRow.getByTestId('leaderboard-delta')).toHaveCount(1);

    // Roster score is the same decimal total as the leaderboard (integer tenths).
    for (const [id, decimal] of [
      [cId, '12.0'],
      [aId, '7.3'],
    ] as const) {
      const rosterScore = host.page
        .locator(`[data-testid="roster-row"][data-player-id="${id}"]`)
        .getByTestId('player-score');
      const boardTotal = await host.page
        .locator(`[data-testid="leaderboard-row"][data-player-id="${id}"]`)
        .locator('.br-lb__pts [aria-hidden="true"]')
        .innerText();
      expect(boardTotal).toBe(decimal);
      await expect(rosterScore).toContainText(decimal);
    }

    // Host skips the reveal hold and lands on the finale.
    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'FINAL');
    await Promise.all(stages.map((stage) => waitForPhase(stage.page, 'FINAL')));

    await expect(host.page.getByTestId('final-phase')).toBeVisible();
    const podium = await host.page
      .locator('[data-testid="final-podium-place"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-rank') ?? ''),
      );
    expect(podium).toEqual(expect.arrayContaining(['1', '2', '3']));
    const standings = await rankedRowMap(host.page, 'final-standing-row');
    expect(standings[cId!]).toBe('1');
    expect(standings[aId!]).toBe('2');
    expect(standings[bId!]).toBe('3');
    expect(standings[dId!]).toBe('4');
    await expect(
      host.page.getByTestId('final-round-winner').locator('a'),
    ).toHaveAttribute('href', `https://www.youtube.com/watch?v=${SONG_C}`);

    // The non-host waits for the host; only the host can rematch.
    await expect(bob.page.getByTestId('final-waiting-host')).toBeVisible();
    await expect(bob.page.getByTestId('final-rematch')).toHaveCount(0);
    await expect(host.page.getByTestId('final-rematch')).toBeVisible();
    await host.page.getByTestId('final-rematch').click();
    await Promise.all(stages.map((stage) => waitForPhase(stage.page, 'LOBBY')));

    const lobby = await stateOf(host.page);
    expect(lobby?.phase.type).toBe('LOBBY');
    expect(lobby?.settings.rounds).toBe(1);
    expect(lobby?.results).toEqual([]);
    for (const id of [aId!, bId!, cId!, dId!]) {
      expect(lobby?.players[id]?.totalScore).toBe(0);
    }
  } finally {
    await closeStages(stages);
  }
});

test('AK-2: a duplicated song cannot be rated by its owners, who both score it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host, bob, cara] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(OTHER)];
    await assembleRoom(host, [bob, cara]);
    await playToPlayback(pages, medias);

    const state = await stateOf(host.page);
    const dup = state?.round?.songs.find((song) => song.media.videoId === DUP);
    expect(dup?.ownerIds).toHaveLength(2);
    const [aId, bId, cId] = await Promise.all(pages.map(playerId));
    expect(new Set(dup?.ownerIds)).toEqual(new Set([aId, bId]));
    expect(dup?.ownerIds).not.toContain(cId);

    // The two songs play in a shuffled order; each gets its own checks.
    let dupPlayed = false;
    for (;;) {
      const now = await stateOf(host.page);
      if (now?.phase.type !== 'PLAYBACK') {
        break;
      }
      const playing = now.round?.playbackOrder[now.phase.index];
      for (const page of pages) {
        await expect(page.getByTestId('playback-phase')).toHaveAttribute(
          'data-index',
          String(now.phase.index),
        );
      }
      if (playing === DUP) {
        // Both owners see "your song" and cannot rate or genre-fail it; the
        // uninvolved third player gets the bar and may pick the genre-fail chip.
        for (const page of [host.page, bob.page]) {
          await expect(page.getByTestId('rating-own')).toBeVisible();
          await expect(page.getByTestId('rating-bar')).toHaveCount(0);
          await expect(page.getByTestId('rating-chip-0')).toHaveCount(0);
        }
        await expect(cara.page.getByTestId('rating-bar')).toBeVisible();
        await expect(cara.page.getByTestId('rating-own')).toHaveCount(0);
        await expect(cara.page.getByTestId('rating-chip-0')).toBeEnabled();

        // A pause freezes rating: the chips stay visible but cannot be pressed.
        expect((await dispatch(host.page, { type: 'PAUSE' })).status).toBe(
          'accepted',
        );
        await expect(cara.page.getByTestId('rating-chip-5')).toBeDisabled();
        expect(
          (await dispatch(cara.page, { type: 'RATE', songId: DUP, value: 5 }))
            .status,
        ).toBe('rejected');
        expect(
          (
            await dispatch(host.page, {
              type: 'RESUME',
              forceBelowMinimum: false,
            })
          ).status,
        ).toBe('accepted');
        await expect(cara.page.getByTestId('rating-chip-5')).toBeEnabled();

        // The owners cannot rate their own song even by raw event.
        for (const page of [host.page, bob.page]) {
          expect(
            (await dispatch(page, { type: 'RATE', songId: DUP, value: 10 }))
              .status,
          ).toBe('rejected');
        }
        await rateByChipKey(cara.page, 8);
        await expect.poll(() => ratingOf(host.page, cId!, DUP)).toBe(8);
        dupPlayed = true;
      } else {
        // Alice and Bob rate Cara's song 6 through the bar, Cara owns it.
        await expect(cara.page.getByTestId('rating-own')).toBeVisible();
        await expect(host.page.getByTestId('rating-bar')).toBeVisible();
        await rateByChipKey(host.page, 6);
        await rateByChipKey(bob.page, 6);
        if (dupPlayed) {
          // The shared song is summarised for everybody who saw it.
          await expect(cara.page.getByTestId('rating-summary')).toContainText(
            '8',
          );
          await expect(host.page.getByTestId('rating-summary')).toBeVisible();
        }
      }
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    expect(dupPlayed).toBe(true);
    await waitForPhase(host.page, 'REVEAL');
    const result = (await stateOf(host.page))?.results[0];
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    // Shared song 8.0 + 2.0 bonus (the winner), full points for both owners.
    expect(scored.get(DUP)).toMatchObject({
      scoreTenths: 80,
      winner: true,
      bonus: 20,
    });
    expect(scored.get(DUP)?.ownerDeltas[aId!]).toBe(100);
    expect(scored.get(DUP)?.ownerDeltas[bId!]).toBe(100);
    expect(scored.get(OTHER)).toMatchObject({ scoreTenths: 60, winner: false });
    await waitForFullReveal(host.page, 2);
    await expect(
      entryOf(host.page, DUP).getByTestId('reveal-entry-points'),
    ).toContainText('10.0');
  } finally {
    await closeStages(stages);
  }
});

test('AK-3: anonymity hides owners until the reveal names them', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [host] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const medias = pages.map((_, index) => mediaFor(7, index));
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(pages, medias);

    // No owner is named while songs play and are rated, including the
    // summary of the songs that already played.
    for (let step = 0; step < medias.length; step += 1) {
      for (const [index, stage] of stages.entries()) {
        const playback = await stage.page
          .getByTestId('playback-phase')
          .innerText();
        for (const [other, competitor] of stages.entries()) {
          if (other !== index) {
            expect(playback).not.toContain(competitor.nickname);
          }
        }
      }
      await rateCurrentSong(pages, medias, () => 5);
      if (step < medias.length - 1) {
        expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
          'accepted',
        );
        await expect(host.page.getByTestId('rating-summary')).toBeVisible();
      }
    }
    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'REVEAL');
    await waitForFullReveal(host.page, 3);
    const entries = await revealEntries(host.page);
    for (const [index, stage] of stages.entries()) {
      const entry = entries.find(
        (candidate) => candidate.videoId === medias[index]!.videoId,
      );
      expect(entry?.owners).toContain(stage.nickname);
    }
  } finally {
    await closeStages(stages);
  }
});

test('FR-41/FR-52: the genre-fail chip (rating 0) fails a song once a majority picks it', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
    newStage(browser, { nickname: 'Dana' }),
  ]);
  try {
    const [host, bob, cara] = stages as [Stage, Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const songs = [SONG_A, SONG_B, SONG_C, SONG_D];
    const medias = songs.map((id) => mediaOf(id));
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(pages, medias);

    const [aId, bId] = await Promise.all([
      playerId(host.page),
      playerId(bob.page),
    ]);

    // FR-52: two of the three non-owners picking the genre-fail chip is a
    // strict majority. The chip is the rating 0: it counts in the mean and a
    // number replaces it. Everyone gives the foreign songs 5 and Cara's song 9;
    // Alice and Bob give song D the chip, Cara gives it a 9, so it averages 3.0.
    const values: RatingMatrix = [
      [null, 5, 9, 0],
      [5, null, 9, 0],
      [5, 5, null, 9],
      [5, 5, 9, null],
    ];
    const rate: RatingFn = (rater, song) => values[rater]?.[song] ?? null;
    // Song D is rated through the chip bar below; the other songs by session.
    const skipD: RatingFn = (rater, song) =>
      song === 3 ? null : (rate(rater, song) ?? null);
    await advanceToSong(pages, SONG_D, { medias, value: rate });
    const chipHost = host.page.getByTestId('rating-chip-0');
    await chipHost.click();
    await expect(chipHost).toHaveAttribute('aria-pressed', 'true');
    await expect(host.page.getByTestId('rating-current')).toHaveAttribute(
      'data-rating',
      '0',
    );
    await expect.poll(() => ratingOf(host.page, aId, SONG_D)).toBe(0);

    // A number replaces the genre fail atomically and clears it again.
    await rateByUi(bob.page, 7);
    await expect(bob.page.getByTestId('rating-chip-0')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect.poll(() => ratingOf(bob.page, bId, SONG_D)).toBe(7);
    await rateByUi(bob.page, 0);
    await expect.poll(() => ratingOf(bob.page, bId, SONG_D)).toBe(0);
    await rateByUi(cara.page, 9);

    await ratePlayback(pages, medias, skipD);
    await waitForFullReveal(host.page, 4);

    const entries = await revealEntries(host.page);
    const failed = entries.find((entry) => entry.videoId === SONG_D);
    expect(failed?.genreFailed).toBe(true);
    // Average 3.0 plus the -3.0 penalty is 0.0 for the flagged owner.
    expect(failed?.points).toContain('0.0');
    const failedCombo = entryOf(host.page, SONG_D).getByTestId('score-combo');
    await expect(failedCombo.getByTestId('score-combo-total')).toHaveText(
      '0.0',
      { timeout: 5_000 },
    );
    await expect(failedCombo.getByTestId('score-combo-adjust')).toHaveText(
      '3.0',
    );
    await expect(failedCombo).toHaveAttribute('data-adjust', '-30');
    // Two of the three non-owners rated it 0; the count is rendered, not a placeholder.
    const failNote = entryOf(host.page, SONG_D).getByTestId(
      'reveal-entry-genre-fail',
    );
    await expect(failNote).toHaveText(/(?:^|\D)2(?:\D|$)/);
    await expect(failNote).not.toContainText('{{');

    const result = (await stateOf(host.page))?.results[0];
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    expect(scored.get(SONG_D)).toMatchObject({
      genreFailed: true,
      scoreTenths: 30,
      winner: false,
    });
    expect(scored.get(SONG_C)).toMatchObject({
      winner: true,
      scoreTenths: 90,
    });
  } finally {
    await closeStages(stages);
  }
});

test('FR-40/FR-50: unrated songs score 0.0 with a note, ratings close with PLAYBACK', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(PART_A), mediaOf(PART_B), mediaOf(PART_C)];
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(pages, medias);

    const [aId, bId, cId] = await Promise.all(pages.map(playerId));
    // Cara rates nothing; B's song is rated by nobody, A's by Bob only.
    const values: RatingMatrix = [
      [null, null, 4],
      [7, null, 6],
      [null, null, null],
    ];
    await ratePlayback(pages, medias, (rater, song) => values[rater]![song]!);

    const result = (await stateOf(host.page))?.results[0];
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    // A: one rating of 7 = 7.0 (winner, +2.0); B: no rating = 0.0; C: 4 and 6 = 5.0.
    expect(scored.get(PART_A)).toMatchObject({
      scoreTenths: 70,
      ratingCount: 1,
      winner: true,
    });
    expect(scored.get(PART_B)).toMatchObject({
      scoreTenths: 0,
      ratingCount: 0,
      basis: 'noRating',
    });
    expect(scored.get(PART_C)).toMatchObject({
      scoreTenths: 50,
      ratingCount: 2,
    });
    expect(result?.playerDeltas).toEqual({
      [aId!]: 90,
      [bId!]: 0,
      [cId!]: 50,
    });
    await waitForFullReveal(host.page, 3);
    const entries = await revealEntries(host.page);
    expect(entries.map((entry) => entry.videoId)).toEqual([
      PART_B,
      PART_C,
      PART_A,
    ]);
    await expect(
      entryOf(host.page, PART_B).getByTestId('reveal-entry-note'),
    ).toBeVisible();
    await expect(
      entryOf(host.page, PART_B).getByTestId('score-combo-total'),
    ).toHaveText('0.0', { timeout: 5_000 });

    // The window closed with PLAYBACK: a late RATE is rejected.
    expect(
      (await dispatch(pages[2]!, { type: 'RATE', songId: PART_A, value: 9 }))
        .status,
    ).toBe('rejected');
  } finally {
    await closeStages(stages);
  }
});

test('FR-54: 3 players, one skips: the remaining songs are rated and scored', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    for (const page of pages) {
      await unlockSound(page);
    }
    expect((await dispatch(host.page, { type: 'START_GAME' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'GENRE_SPIN');
    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'SUBMISSION');
    await Promise.all(pages.map((page) => waitForPhase(page, 'SUBMISSION')));
    // Alice and Bob submit; Cara skips the round by finishing without a song.
    for (const [index, page] of pages.slice(0, 2).entries()) {
      expect(
        (
          await dispatch(page, {
            type: 'SUBMIT_SONG',
            media: mediaFor(5, index),
          })
        ).status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_SUBMISSION' })).status).toBe(
        'accepted',
      );
    }
    expect(
      (await dispatch(pages[2]!, { type: 'FINISH_SUBMISSION' })).status,
    ).toBe('accepted');
    await waitForPhase(host.page, 'PLAYBACK');

    const medias = [mediaFor(5, 0), mediaFor(5, 1)];
    expect((await stateOf(host.page))?.round?.songs).toHaveLength(2);
    // Bob rates Alice 6, Alice rates Bob 6, Cara rates Alice 9 and Bob 8.
    const values: RatingMatrix = [
      [null, 6],
      [6, null],
      [9, 8],
    ];
    await ratePlayback(pages, medias, (rater, song) => values[rater]![song]!);

    const result = (await stateOf(host.page))?.results[0];
    expect(result?.reason).toBe('normal');
    expect(result?.songs).toHaveLength(2);
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    // Alice: (6 + 9) / 2 = 7.5 and the winner bonus; Bob: (6 + 8) / 2 = 7.0.
    expect(scored.get(medias[0]!.videoId)).toMatchObject({
      scoreTenths: 75,
      winner: true,
    });
    expect(scored.get(medias[1]!.videoId)).toMatchObject({
      scoreTenths: 70,
      winner: false,
    });
    const aId = await playerId(host.page);
    expect(result?.playerDeltas[aId]).toBe(95);
    await waitForFullReveal(host.page, 2);
  } finally {
    await closeStages(stages);
  }
});

test('FR-50/FR-54: a song every player owns is rated normally and pays a fixed 5.0', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(DUP)];
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(pages, medias);

    // One aggregated song, owned by everyone: nobody gets a chip bar.
    const state = await stateOf(host.page);
    expect(state?.round?.songs).toHaveLength(1);
    expect(state?.round?.playbackOrder).toEqual([DUP]);
    for (const page of pages) {
      await expect(page.getByTestId('rating-own')).toBeVisible();
      await expect(page.getByTestId('rating-bar')).toHaveCount(0);
    }
    await ratePlayback(pages, medias, () => null);

    const result = (await stateOf(host.page))?.results[0];
    expect(result?.reason).toBe('normal');
    expect(result?.songs[0]).toMatchObject({
      basis: 'noRaters',
      scoreTenths: 50,
      winner: false,
      bonus: 0,
    });
    const deltas = Object.values(result?.playerDeltas ?? {});
    expect(deltas).toHaveLength(3);
    expect(deltas.every((delta) => delta === 50)).toBe(true);
    await waitForFullReveal(host.page, 1);
    await expect(host.page.getByTestId('reveal-entry-note')).toBeVisible();
    await expect(host.page.getByTestId('score-combo-total')).toHaveText('5.0', {
      timeout: 5_000,
    });
  } finally {
    await closeStages(stages);
  }
});
