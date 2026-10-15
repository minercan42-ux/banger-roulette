import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  dispatch,
  newStage,
  stateOf,
  waitForPhase,
  type Stage,
} from './m3-support';
import { advanceToVoting, playToPlayback } from './m5-support';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';

/**
 * FR-60 jackpot and FR-26 Spiritually Linked in the reveal: the show runs
 * once, inside the winner's 2500 ms reveal slot, and leaves nothing behind;
 * under reduced motion there is no chip rain, shake or swirl tempo.
 */

const DUP = 'm7dupe00001';
const SOLO = 'm7solo00002';

function mediaOf(videoId: string): Media {
  return {
    videoId,
    title: fixtureTitle(videoId),
    channel: FIXTURE_CHANNEL,
    thumbnail: fixtureThumbnail(videoId),
    durationSeconds: 200,
    startSeconds: 0,
  };
}

/**
 * Alice and Bob submit the same video (linked, worst ranked), Cara a solo
 * song that both of them rank first: the solo song wins and closes the reveal.
 */
async function playToReveal(stages: Stage[]): Promise<void> {
  const pages = stages.map((stage) => stage.page);
  await assembleRoom(stages[0]!, stages.slice(1));
  await playToPlayback(pages, [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)]);
  await advanceToVoting(pages);
  const ballots: Array<[Page, string[]]> = [
    [pages[0]!, [SOLO]],
    [pages[1]!, [SOLO]],
    [pages[2]!, [DUP]],
  ];
  for (const [page, ranking] of ballots) {
    expect(
      (await dispatch(page, { type: 'SET_RANKING', ranking })).status,
    ).toBe('accepted');
    expect((await dispatch(page, { type: 'FINISH_VOTING' })).status).toBe(
      'accepted',
    );
  }
  await waitForPhase(pages[0]!, 'REVEAL');
}

for (const reducedMotion of [false, true] as const) {
  test(`jackpot and linked moment in the reveal (${reducedMotion ? 'reduced motion' : 'full motion'})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const motion = reducedMotion ? 'reduce' : 'no-preference';
    const stages = await Promise.all(
      ['Alice', 'Bob', 'Cara'].map((nickname) =>
        newStage(browser, { nickname, reducedMotion: motion }),
      ),
    );
    try {
      await playToReveal(stages);
      const host = stages[0]!.page;
      const show = host.getByTestId('jackpot-show');

      // Linked entry first (worst-first): banner and, in the reveal, the names.
      const linked = host.getByTestId('linked-animation');
      await expect(linked).toBeVisible({ timeout: 10_000 });
      await expect(linked.locator('.br-linked__banner')).toBeVisible();
      await expect(linked.getByTestId('linked-names')).toContainText('Alice');
      await expect(linked.getByTestId('linked-names')).toContainText('Bob');
      await expect(show).toHaveCount(0);
      await expect(host.getByTestId('reveal-jackpot')).toHaveCount(0);

      // The winner is revealed 2500 ms later: the show starts and ends on
      // server time (the 2400 ms bound is pinned in Jackpot.test.tsx; the wall
      // clock budget here only leaves room for a loaded CI runner).
      await expect(show).toBeVisible({ timeout: 6000 });
      await expect(host.getByTestId('reveal-jackpot')).toHaveCount(1);
      await expect(show.locator('.br-jackpot__word')).toHaveText('JACKPOT!');
      await expect(show.locator('.br-jackpot__sub')).toContainText('Cara');
      const backdrop = host.getByTestId('backdrop');
      const panel = host.locator('.br-panel', {
        has: host.getByTestId('reveal-phase'),
      });
      if (reducedMotion) {
        await expect(show.locator('.br-rain')).toHaveCount(0);
        await expect(backdrop).not.toHaveClass(/is-hype/);
        await expect(panel).not.toHaveClass(/br-shake/);
      } else {
        await expect(show.locator('.br-rain .br-chip')).toHaveCount(26);
        await expect(backdrop).toHaveClass(/is-hype/);
      }
      await expect(show).toBeHidden({ timeout: 5000 });
      await expect(backdrop).not.toHaveClass(/is-hype/);
      await expect(panel).not.toHaveClass(/br-shake/);

      // Settled: the badge on the winning entry stays, the show does not return.
      await expect(
        host
          .locator(`[data-testid="reveal-entry"][data-video-id="${SOLO}"]`)
          .getByTestId('reveal-jackpot'),
      ).toHaveCount(1);
      await expect(host.getByTestId('leaderboard')).toBeVisible();
      await expect(show).toHaveCount(0);
      expect((await stateOf(host))?.phase.type).toBe('REVEAL');
    } finally {
      await closeStages(stages);
    }
  });
}
