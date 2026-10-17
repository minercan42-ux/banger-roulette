import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assembleRoom,
  closeStages,
  newStage,
  snapshot,
  stateOf,
  type Stage,
} from './m3-support';
import { mediaFor, playToPlayback } from './m5-support';

/**
 * Issue #110 / FR-43: during a song every participant can vote Skip (non-owners
 * only after rating it); at ceil(0.9 n) votes the host ends the song and the
 * next one starts on every client with the same server-normalized startAt.
 */
test('FR-43: 3 of 4 skip votes keep the song, the 4th starts the next song everywhere', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
    newStage(browser, { nickname: 'Dana' }),
  ]);
  try {
    const [host] = stages as [Stage, Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    const medias = pages.map((_, index) => mediaFor(9, index));
    await assembleRoom(host, stages.slice(1));
    await playToPlayback(pages, medias);

    // The playback order is shuffled: read which page owns the playing song.
    const state = await stateOf(host.page);
    const round = state!.round!;
    const songId = round.playbackOrder[0]!;
    const ownerId = round.songs.find((song) => song.media.videoId === songId)!
      .ownerIds[0]!;
    const ids = await Promise.all(
      pages.map(async (page) => (await snapshot(page)).clientId),
    );
    const ownerIndex = ids.indexOf(ownerId);
    const raters = pages.filter((_, index) => index !== ownerIndex);
    const owner = pages[ownerIndex]!;

    const skip = (page: Page) => page.getByTestId('playback-skip');
    const count = (page: Page) => page.getByTestId('playback-skip-count');
    const hint = (page: Page) => page.getByTestId('playback-skip-hint');

    // Before rating: a non-owner sees the disabled button with the hint, the
    // owner can vote straight away.
    for (const page of pages) {
      await expect(count(page)).toHaveText('0/4 want to skip');
    }
    for (const rater of raters) {
      await expect(skip(rater)).toBeDisabled();
      await expect(hint(rater)).toHaveText('Rate first, then skip.');
    }
    await expect(skip(owner)).toBeEnabled();
    await expect(hint(owner)).toHaveCount(0);

    // Rating unlocks the button and removes the hint.
    for (const rater of raters) {
      await rater.getByTestId('rating-chip-5').click();
      await expect(skip(rater)).toBeEnabled();
      await expect(hint(rater)).toHaveCount(0);
    }

    // Three of four votes: everybody shows 3/4, the song keeps playing.
    const voters = [owner, raters[0]!, raters[1]!];
    for (const voter of voters) {
      await skip(voter).click();
      await expect(skip(voter)).toHaveAttribute('data-voted', 'true');
      await expect(skip(voter)).toHaveText('Keep listening');
    }
    for (const page of pages) {
      await expect(count(page)).toHaveText('3/4 want to skip');
    }
    await host.page.waitForTimeout(1500);
    for (const page of pages) {
      await expect(page.getByTestId('playback-phase')).toHaveAttribute(
        'data-index',
        '0',
      );
      expect((await stateOf(page))?.phase).toMatchObject({ index: 0 });
    }

    // A vote can be withdrawn and cast again.
    await skip(raters[0]!).click();
    await expect(skip(raters[0]!)).toHaveAttribute('data-voted', 'false');
    await expect(skip(raters[0]!)).toHaveText('Skip');
    for (const page of pages) {
      await expect(count(page)).toHaveText('2/4 want to skip');
    }
    await skip(raters[0]!).click();
    for (const page of pages) {
      await expect(count(page)).toHaveText('3/4 want to skip');
    }

    // The fourth vote reaches ceil(0.9 * 4) = 4: every page moves to song 2.
    await skip(raters[2]!).click();
    await Promise.all(
      pages.map((page) =>
        expect(
          page.locator('[data-testid="playback-phase"][data-index="1"]'),
        ).toBeVisible({ timeout: 3000 }),
      ),
    );
    const phases = await Promise.all(
      pages.map(async (page) => (await stateOf(page))?.phase),
    );
    for (const phase of phases) {
      expect(phase).toMatchObject({
        type: 'PLAYBACK',
        index: 1,
        skipVoterIds: [],
      });
    }
    const startAts = phases.map((phase) =>
      phase?.type === 'PLAYBACK' ? phase.startAt : null,
    );
    expect(new Set(startAts).size).toBe(1);

    // The new song starts without votes.
    for (const page of pages) {
      await expect(count(page)).toHaveText('0/4 want to skip');
    }
  } finally {
    await closeStages(stages);
  }
});
