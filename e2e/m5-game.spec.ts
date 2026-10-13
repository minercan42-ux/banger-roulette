import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
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
  waitForPhase,
  type Stage,
} from './m3-support';
import {
  advanceToVoting,
  finishVoting,
  mediaFor,
  playToPlayback,
  submitSongsAndFinish,
} from './m5-support';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';

/**
 * M5 consumer coverage: the first completely playable game. Voting (FR-40..42),
 * genre-fail (FR-34/41/52), scoring (FR-50..54) and reveal/leaderboard/finale
 * (FR-60..62) are driven through the real UI on top of the real `GameSession`
 * and engine; only the external YouTube edge is replaced by the fixture.
 *
 * The voting/reveal/final assertions target the documented data-testid contract;
 * rankings are entered through `voting-song-add` / `voting-rank-up|down` with one
 * real drag-and-drop (`locator.dragTo`) for desktop coverage. Phase timing is
 * skipped with the host `ADVANCE` where it is irrelevant, so every scenario is
 * deterministic and fully-parallel safe.
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

function rankItem(page: Page, videoId: string) {
  return page.locator(
    `[data-testid="voting-rank-item"][data-video-id="${videoId}"]`,
  );
}

function flagItem(page: Page, videoId: string) {
  return page.locator(
    `[data-testid="voting-flag"][data-video-id="${videoId}"]`,
  );
}

function poolItem(page: Page, videoId: string) {
  return page.locator(
    `[data-testid="voting-song"][data-video-id="${videoId}"]`,
  );
}

async function rankedIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="voting-rank-item"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-video-id') ?? ''),
    );
}

async function playerId(page: Page): Promise<string> {
  return (await snapshot(page)).clientId;
}

async function ballotOf(page: Page, id: string): Promise<string[]> {
  const state = await stateOf(page);
  return state?.round?.ballots?.[id]?.ranking ?? [];
}

async function flagsOf(page: Page, id: string): Promise<string[]> {
  const state = await stateOf(page);
  return state?.round?.genreFailFlags?.[id] ?? [];
}

/** Adds every missing song, then reorders to `desired` with up/down buttons. */
async function ensureRanking(
  page: Page,
  desired: readonly string[],
): Promise<void> {
  for (const videoId of desired) {
    const item = rankItem(page, videoId);
    if ((await item.count()) === 0) {
      await poolItem(page, videoId).getByTestId('voting-song-add').click();
      await expect(item).toHaveCount(1);
    }
  }
  for (let target = 0; target < desired.length; target += 1) {
    const videoId = desired[target]!;
    const item = rankItem(page, videoId);
    const rank = async () => Number(await item.getAttribute('data-rank'));
    let current = await rank();
    while (current > target + 1) {
      await item.getByTestId('voting-rank-up').click();
      await expect.poll(rank, { timeout: 5000 }).toBe(current - 1);
      current -= 1;
    }
    while (current < target + 1) {
      await item.getByTestId('voting-rank-down').click();
      await expect.poll(rank, { timeout: 5000 }).toBe(current + 1);
      current += 1;
    }
  }
  await expect.poll(() => rankedIds(page)).toEqual([...desired]);
}

/** Ranks exactly `desired` through the UI and asserts engine/UI agreement. */
async function setBallot(
  page: Page,
  id: string,
  desired: readonly string[],
): Promise<void> {
  await ensureRanking(page, desired);
  await expect.poll(() => ballotOf(page, id)).toEqual([...desired]);
}

async function finishVotingUi(page: Page): Promise<void> {
  const id = await playerId(page);
  await page.getByTestId('voting-finish').click();
  // The last voter leaves VOTING immediately, so accept either the done marker
  // or the phase transition.
  await expect
    .poll(
      async () => {
        const state = await stateOf(page);
        if (state?.phase.type !== 'VOTING') {
          return 'left';
        }
        return state.round?.votingDoneIds.includes(id) === true
          ? 'done'
          : 'wait';
      },
      { timeout: 10_000 },
    )
    .not.toBe('wait');
}

interface RevealEntry {
  videoId: string;
  winner: boolean;
  genreFailed: boolean;
  owners: string;
  points: string;
}

async function revealEntries(page: Page): Promise<RevealEntry[]> {
  return page.locator('[data-testid="reveal-entry"]').evaluateAll((elements) =>
    elements.map((element) => ({
      videoId: element.getAttribute('data-video-id') ?? '',
      winner: element.getAttribute('data-winner') === 'true',
      genreFailed: element.getAttribute('data-genre-failed') === 'true',
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
 * FR-60 reveals worst-first against server time, one entry every 2500ms, so the
 * full list (and the leaderboard) only appears after the last entry's revealAt.
 */
async function waitForFullReveal(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('reveal-entry')).toHaveCount(count, {
    timeout: count * 2500 + 10_000,
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

function songsById(state: GameState | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const song of state?.round?.songs ?? []) {
    map.set(song.media.videoId, song.ownerIds[0] ?? '');
  }
  return map;
}

test('full game: voting, scoring, reveal, leaderboard and rematch', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
    newStage(browser, { nickname: 'Dana' }),
  ]);
  try {
    const [host, bob, cara, dana] = stages as [Stage, Stage, Stage, Stage];
    const all = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await setSettings(host.page, { rounds: 1 });
    await enterSubmission(all);

    // Every player submits a distinct song through the visible submission flow.
    const urls = [SONG_A, SONG_B, SONG_C, SONG_D].map(
      (id) => `https://www.youtube.com/watch?v=${id}`,
    );
    for (const [index, page] of all.entries()) {
      await submitSongViaUi(page, urls[index]!);
      await page.getByTestId('finish-submission').click();
    }
    await waitForPhase(host.page, 'PLAYBACK');

    // Skip every clip; the reveal/leaderboard timing is asserted via ADVANCE.
    const songCount = (await stateOf(host.page))?.round?.songs.length ?? 0;
    for (let index = 0; index < songCount; index += 1) {
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'VOTING');
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'VOTING')),
    );

    const owner = songsById(await stateOf(host.page));
    const [aId, bId, cId, dId] = await Promise.all(all.map(playerId));
    expect(owner.get(SONG_A)).toBe(aId);
    expect(owner.get(SONG_C)).toBe(cId);

    // AK-8 ballots: A: C>B>D, B: C>A>D, C: A>B>D, D: C>A>B.
    const ballots: Array<[Page, string, string[]]> = [
      [host.page, aId!, [SONG_C, SONG_B, SONG_D]],
      [bob.page, bId!, [SONG_C, SONG_A, SONG_D]],
      [cara.page, cId!, [SONG_A, SONG_B, SONG_D]],
      [dana.page, dId!, [SONG_C, SONG_A, SONG_B]],
    ];

    // Real desktop drag-and-drop: move the last rank onto the first.
    await setBallot(host.page, aId!, [SONG_C, SONG_B, SONG_D]);
    await rankItem(host.page, SONG_D).dragTo(rankItem(host.page, SONG_C));
    await expect
      .poll(() => rankedIds(host.page), { timeout: 5000 })
      .toEqual([SONG_D, SONG_C, SONG_B]);
    await expect
      .poll(() => ballotOf(host.page, aId!))
      .toEqual([SONG_D, SONG_C, SONG_B]);
    // Restore the planned ballot with the deterministic reorder controls.
    await setBallot(host.page, aId!, [SONG_C, SONG_B, SONG_D]);

    for (const [page, id, ranking] of ballots.slice(1)) {
      await setBallot(page, id, ranking);
    }

    // Every player finishes; the room must end voting early into REVEAL.
    for (const [index, page] of all.entries()) {
      await finishVotingUi(page);
      if (index < all.length - 1) {
        const id = ballots[index]![1];
        await expect
          .poll(() =>
            host.page
              .locator(
                `[data-testid="voting-progress-player"][data-player-id="${id}"]`,
              )
              .getAttribute('data-done'),
          )
          .toBe('true');
      }
    }
    await waitForPhase(host.page, 'REVEAL');
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'REVEAL')),
    );
    await waitForFullReveal(host.page, 4);

    const entries = await revealEntries(host.page);
    // Ascending Borda: D(3), B(5), A(7), C(9 + 2 bonus = 11).
    expect(entries.map((entry) => entry.videoId)).toEqual([
      SONG_D,
      SONG_B,
      SONG_A,
      SONG_C,
    ]);
    const byVideo = Object.fromEntries(entries.map((e) => [e.videoId, e]));
    expect(byVideo[SONG_C]?.winner).toBe(true);
    expect(byVideo[SONG_C]?.points).toMatch(/(?:^|\D)11(?:\D|$)/);
    expect(byVideo[SONG_A]?.points).toMatch(/(?:^|\D)7(?:\D|$)/);
    expect(byVideo[SONG_B]?.points).toMatch(/(?:^|\D)5(?:\D|$)/);
    expect(byVideo[SONG_D]?.points).toMatch(/(?:^|\D)3(?:\D|$)/);
    expect(entries.filter((entry) => entry.genreFailed)).toEqual([]);
    await expect(host.page.getByTestId('reveal-jackpot')).toHaveCount(1);
    await expect(
      host.page
        .locator(`[data-testid="reveal-entry"][data-video-id="${SONG_C}"]`)
        .getByTestId('reveal-jackpot'),
    ).toHaveCount(1);

    // Scoring matches the engine's own result, not just the rendered text.
    const revealed = await stateOf(host.page);
    const result = revealed?.results[0];
    expect(result?.reason).toBe('normal');
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    expect(scored.get(SONG_C)?.borda).toBe(9);
    expect(scored.get(SONG_C)?.bonus).toBe(2);
    expect(scored.get(SONG_C)?.winner).toBe(true);
    expect(scored.get(SONG_A)?.borda).toBe(7);
    expect(scored.get(SONG_B)?.borda).toBe(5);
    expect(scored.get(SONG_D)?.borda).toBe(3);
    expect(scored.get(SONG_C)?.ownerDeltas[cId!]).toBe(11);
    expect(scored.get(SONG_A)?.ownerDeltas[aId!]).toBe(7);

    // Interim leaderboard ranks mirror the round totals.
    const ranks = await rankedRowMap(host.page, 'leaderboard-row');
    expect(ranks[cId!]).toBe('1');
    expect(ranks[aId!]).toBe('2');
    expect(ranks[bId!]).toBe('3');
    expect(ranks[dId!]).toBe('4');
    await expect(
      host.page
        .locator(`[data-testid="leaderboard-row"][data-player-id="${cId}"]`)
        .getByTestId('leaderboard-delta'),
    ).toHaveCount(1);

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

test('AK-2: a duplicated song is hidden from both owners during voting', async ({
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
    await assembleRoom(host, [bob, cara]);
    await playToPlayback(pages, [mediaOf(DUP), mediaOf(DUP), mediaOf(OTHER)]);
    await advanceToVoting(pages);

    const state = await stateOf(host.page);
    const dup = state?.round?.songs.find((song) => song.media.videoId === DUP);
    expect(dup?.ownerIds).toHaveLength(2);
    const [aId, bId, cId] = await Promise.all(pages.map(playerId));
    expect(new Set(dup?.ownerIds)).toEqual(new Set([aId, bId]));

    // Both owners neither see nor flag their shared song...
    for (const page of [host.page, bob.page]) {
      await expect(poolItem(page, DUP)).toHaveCount(0);
      await expect(rankItem(page, DUP)).toHaveCount(0);
      await expect(flagItem(page, DUP)).toHaveCount(0);
      await expect(flagItem(page, OTHER)).toHaveCount(1);
    }
    // ...the uninvolved third player sees it and may flag it.
    await expect(poolItem(cara.page, DUP)).toHaveCount(1);
    await expect(flagItem(cara.page, DUP)).toHaveCount(1);
    await expect(flagItem(cara.page, OTHER)).toHaveCount(0);
    expect(cId).not.toBe(aId);
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

    // No owner is named while songs are playing and while voting.
    for (const [index, stage] of stages.entries()) {
      const playback = await stage.page
        .getByTestId('playback-phase')
        .innerText();
      for (const [other, competitor] of stages.entries()) {
        if (other !== index)
          expect(playback).not.toContain(competitor.nickname);
      }
    }
    await advanceToVoting(pages);
    for (const [index, stage] of stages.entries()) {
      // The progress list names players; the song cards must not.
      await expect(stage.page.getByTestId('voting-song-owners')).toHaveCount(0);
      const cards = stage.page.locator(
        '[data-testid="voting-song"], [data-testid="voting-rank-item"]',
      );
      for (const text of await cards.allInnerTexts()) {
        for (const [other, competitor] of stages.entries()) {
          if (other !== index) expect(text).not.toContain(competitor.nickname);
        }
      }
    }

    await finishVoting(pages, medias);
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

test('FR-41/FR-52: a voting flag retracts and a majority fails the song', async ({
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
    const [host, bob] = stages as [Stage, Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(
      pages,
      [SONG_A, SONG_B, SONG_C, SONG_D].map((id) => mediaOf(id)),
    );
    await advanceToVoting(pages);

    const [aId, bId] = await Promise.all([
      playerId(host.page),
      playerId(bob.page),
    ]);

    // FR-41: a flag can be retracted before voting finishes.
    const flagBobSong = flagItem(host.page, SONG_B);
    await flagBobSong.click();
    await expect(flagBobSong).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => flagsOf(host.page, aId)).toContain(SONG_B);
    await flagBobSong.click();
    await expect(flagBobSong).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => flagsOf(host.page, aId)).not.toContain(SONG_B);

    // FR-52: two of the three non-owners flagging is a strict majority.
    await flagItem(host.page, SONG_D).click();
    await flagItem(bob.page, SONG_D).click();
    await expect(flagItem(host.page, SONG_D)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(flagItem(bob.page, SONG_D)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const ballots: Array<[Page, string, string[]]> = [
      [host.page, aId, [SONG_C, SONG_B, SONG_D]],
      [bob.page, bId, [SONG_C, SONG_A, SONG_D]],
      [
        stages[2]!.page,
        await playerId(stages[2]!.page),
        [SONG_A, SONG_B, SONG_D],
      ],
      [
        stages[3]!.page,
        await playerId(stages[3]!.page),
        [SONG_C, SONG_A, SONG_B],
      ],
    ];
    for (const [page, id, ranking] of ballots) {
      await setBallot(page, id, ranking);
    }
    for (const page of pages) {
      await finishVotingUi(page);
    }
    await waitForPhase(host.page, 'REVEAL');
    await waitForFullReveal(host.page, 4);

    const entries = await revealEntries(host.page);
    const failed = entries.find((entry) => entry.videoId === SONG_D);
    expect(failed?.genreFailed).toBe(true);
    // borda 3 + penalty (-3) = 0 for the flagged owner.
    expect(failed?.points).toMatch(/(?:^|\D)0(?:\D|$)/);

    const result = (await stateOf(host.page))?.results[0];
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    expect(scored.get(SONG_D)?.genreFailed).toBe(true);
    expect(scored.get(SONG_D)?.borda).toBe(3);
    expect(scored.get(SONG_D)?.winner).toBe(false);
    expect(scored.get(SONG_C)?.winner).toBe(true);
    expect(scored.get(SONG_C)?.borda).toBe(9);
  } finally {
    await closeStages(stages);
  }
});

test('FR-42: partial rankings are accepted and voting ends when everyone is done', async ({
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
    await playToPlayback(pages, [
      mediaOf(PART_A),
      mediaOf(PART_B),
      mediaOf(PART_C),
    ]);
    await advanceToVoting(pages);

    const [aId, bId, cId] = await Promise.all(pages.map(playerId));
    // A ranks only one of the two foreign songs; partial ranking is allowed.
    await setBallot(host.page, aId, [PART_C]);
    await finishVotingUi(host.page);
    const afterPartial = await stateOf(host.page);
    expect(afterPartial?.phase.type).toBe('VOTING');
    expect(afterPartial?.round?.ballots?.[aId]?.ranking).toEqual([PART_C]);
    await expect
      .poll(() =>
        host.page
          .locator(
            `[data-testid="voting-progress-player"][data-player-id="${aId}"]`,
          )
          .getAttribute('data-done'),
      )
      .toBe('true');

    await setBallot(stages[1]!.page, bId, [PART_A, PART_C]);
    await finishVotingUi(stages[1]!.page);
    await setBallot(stages[2]!.page, cId, [PART_A, PART_B]);
    const started = Date.now();
    await finishVotingUi(stages[2]!.page);

    // Everyone is done, so the room leaves VOTING long before its 60s deadline.
    await waitForPhase(host.page, 'REVEAL', 20_000);
    expect(Date.now() - started).toBeLessThan(60_000);
    const votingSeconds =
      (await stateOf(host.page))?.settings.votingSeconds ?? 60;
    expect(Date.now() - started).toBeLessThan(votingSeconds * 1000);
    await waitForFullReveal(host.page, 3);

    const result = (await stateOf(host.page))?.results[0];
    const scored = new Map(
      (result?.songs ?? []).map((song) => [song.song.media.videoId, song]),
    );
    // A ranked one (2-point ballot + 3-point ballot): PART_A 4, PART_C 2, PART_B 1.
    expect(scored.get(PART_A)?.borda).toBe(4);
    expect(scored.get(PART_C)?.borda).toBe(2);
    expect(scored.get(PART_B)?.borda).toBe(1);
    expect(scored.get(PART_A)?.winner).toBe(true);
    const entries = await revealEntries(host.page);
    expect(entries.map((entry) => entry.videoId)).toEqual([
      PART_B,
      PART_C,
      PART_A,
    ]);
  } finally {
    await closeStages(stages);
  }
});

test('FR-54: a single deduplicated song skips voting with a notice', async ({
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
    await submitSongsAndFinish(pages, [
      mediaOf(DUP),
      mediaOf(DUP),
      mediaOf(DUP),
    ]);

    // One aggregated song skips PLAYBACK/VOTING and reveals directly.
    await waitForPhase(host.page, 'REVEAL');
    const state = await stateOf(host.page);
    expect(state?.results[0]?.reason).toBe('singleSong');
    const deltas = Object.values(state?.results[0]?.playerDeltas ?? {});
    expect(deltas).toHaveLength(3);
    expect(deltas.every((delta) => delta === 0)).toBe(true);
    await expect(host.page.getByTestId('single-song')).toBeVisible();
    await expect(host.page.getByTestId('single-song-notice')).toBeVisible();
  } finally {
    await closeStages(stages);
  }
});
