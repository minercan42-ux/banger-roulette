import { expect, test, type Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  dispatch,
  newStage,
  stateOf,
  type Stage,
} from './m3-support';
import { playToPlayback, ratePlayback } from './m5-support';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';

/**
 * FR-60 "THIS IS A BANGER": a song whose ratings are all 10 gets a full-viewport
 * show for its whole 5000 ms reveal slot, on every client, and the jackpot show
 * does not run for that entry. Under reduced motion there is no shake, strobe,
 * rain or confetti; a static burst and the slogan fade in. A song below 10.0
 * never gets the show.
 */

const DUP = 'm8dupe00001';
const SOLO = 'm8solo00002';
const FLAT_A = 'm8flat00003';
const FLAT_B = 'm8flat00004';
const FLAT_C = 'm8flat00005';

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

async function openStages(
  browser: Parameters<typeof newStage>[0],
  reducedMotion: 'reduce' | 'no-preference',
): Promise<Stage[]> {
  return Promise.all(
    ['Alice', 'Bob', 'Cara'].map((nickname) =>
      newStage(browser, { nickname, reducedMotion }),
    ),
  );
}

/** Playing animations (CSS and Web Animations) inside the show, by play state. */
function playStates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const show = document.querySelector('[data-testid="banger-show"]');
    return (
      show
        ?.getAnimations({ subtree: true })
        .map((animation) => animation.playState) ?? []
    );
  });
}

/** Panel of the reveal, the thing the screen shake moves. */
function shakeAnimations(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document
        .querySelector('[data-testid="reveal-phase"]')
        ?.closest('.br-panel')
        ?.getAnimations()
        .filter((animation) => animation.playState === 'running').length ?? 0,
  );
}

for (const reducedMotion of [false, true] as const) {
  test(`a round of 10s shows THIS IS A BANGER on every client (${reducedMotion ? 'reduced motion' : 'full motion'})`, async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const stages = await openStages(
      browser,
      reducedMotion ? 'reduce' : 'no-preference',
    );
    try {
      const pages = stages.map((stage) => stage.page);
      // Alice and Bob submit the same video (linked, two owners): Cara is its
      // only rater and gives a 10, so it is a banger and wins the round. Cara's
      // own song gets a 4 and is revealed first.
      const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)];
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, medias);
      await ratePlayback(pages, medias, (rater, song) =>
        song === 2 ? 4 : rater === 2 ? 10 : null,
      );

      const host = pages[0]!;
      const shows = pages.map((page) => page.getByTestId('banger-show'));
      const jackpots = pages.map((page) => page.getByTestId('jackpot-show'));

      // The worst song is revealed first: no banger yet, nothing before it.
      await expect(host.getByTestId('reveal-entry')).toHaveCount(1, {
        timeout: 10_000,
      });
      for (const show of shows) {
        await expect(show).toHaveCount(0);
      }

      // The banger entry starts at 2500 ms on server time: all clients show it.
      for (const show of shows) {
        await expect(show).toBeVisible({ timeout: 8000 });
      }
      const startedAt = Date.now();
      const show = shows[0]!;
      await expect(show.getByTestId('banger-word')).toHaveText(
        'THIS IS A BANGER',
      );
      await expect(show.getByTestId('banger-score')).toHaveText('10.0');
      await expect(show.getByTestId('banger-owner')).toHaveText([
        'Alice',
        'Bob',
      ]);
      await expect(show.getByTestId('banger-card')).toBeVisible();
      await expect(show.getByTestId('banger-sub')).toContainText('Alice, Bob');
      // The jackpot show never runs for the banger, on any client.
      for (const jackpot of jackpots) {
        await expect(jackpot).toHaveCount(0);
      }
      // The winner mark and the entry's banger badge stay on the entry.
      const entry = host.locator(
        `[data-testid="reveal-entry"][data-video-id="${DUP}"]`,
      );
      await expect(entry.getByTestId('reveal-jackpot')).toHaveCount(1);
      await expect(entry.getByTestId('reveal-entry-banger')).toHaveCount(1);

      const backdrop = host.getByTestId('backdrop');
      if (reducedMotion) {
        await expect(show.getByTestId('banger-burst')).toBeVisible();
        await expect(show.getByTestId('banger-rain')).toHaveCount(0);
        await expect(show.getByTestId('banger-strobe')).toHaveCount(0);
        await expect(show.getByTestId('banger-confetti')).toHaveCount(0);
        await expect(backdrop).not.toHaveClass(/is-hype/);
        expect(await shakeAnimations(host)).toBe(0);
      } else {
        await expect(
          show.getByTestId('banger-rain').locator('.br-chip'),
        ).toHaveCount(72);
        await expect(show.getByTestId('banger-strobe')).toHaveCount(1);
        await expect(
          show.getByTestId('banger-confetti').locator('span'),
        ).toHaveCount(64);
        await expect(show.getByTestId('banger-burst')).toHaveCount(0);
        await expect(backdrop).toHaveClass(/is-hype/);
        expect(await shakeAnimations(host)).toBe(1);

        // A host pause freezes the show where it is, a resume lets it go on.
        expect((await dispatch(host, { type: 'PAUSE' })).status).toBe(
          'accepted',
        );
        await expect
          .poll(async () => (await playStates(host)).includes('running'))
          .toBe(false);
        const frozen = await host.evaluate(() => {
          const root = document.querySelector('[data-testid="banger-show"]');
          return (
            root
              ?.getAnimations({ subtree: true })
              .map((animation) => Number(animation.currentTime)) ?? []
          );
        });
        await host.waitForTimeout(600);
        const later = await host.evaluate(() => {
          const root = document.querySelector('[data-testid="banger-show"]');
          return (
            root
              ?.getAnimations({ subtree: true })
              .map((animation) => Number(animation.currentTime)) ?? []
          );
        });
        expect(later).toEqual(frozen);
        await expect(show).toBeVisible();
        expect(
          (await dispatch(host, { type: 'RESUME', forceBelowMinimum: false }))
            .status,
        ).toBe('accepted');
        await expect
          .poll(async () => (await playStates(host)).includes('running'))
          .toBe(true);
      }

      // Gone after its slot, on every client; the swirl and the shake are
      // released with it.
      for (const hidden of shows) {
        await expect(hidden).toBeHidden({ timeout: 12_000 });
        await expect(hidden).toHaveCount(0);
      }
      if (!reducedMotion) {
        await expect(backdrop).not.toHaveClass(/is-hype/);
        expect(await shakeAnimations(host)).toBe(0);
      }
      const lasted = Date.now() - startedAt;
      // 5000 ms slot (plus the pause in full motion, which only delays it).
      expect(lasted).toBeGreaterThan(3500);
      expect(lasted).toBeLessThan(reducedMotion ? 6500 : 16_000);
      for (const jackpot of jackpots) {
        await expect(jackpot).toHaveCount(0);
      }
      await expect(host.getByTestId('leaderboard')).toBeVisible({
        timeout: 10_000,
      });
      expect((await stateOf(host))?.phase.type).toBe('REVEAL');
    } finally {
      await closeStages(stages);
    }
  });
}

test('a 9.5 song is no banger: the jackpot runs and no banger show appears', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, 'no-preference');
  try {
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(FLAT_A), mediaOf(FLAT_B), mediaOf(FLAT_C)];
    await assembleRoom(stages[0]!, stages.slice(1));
    await playToPlayback(pages, medias);
    // Cara's song gets a 10 and a 9: a 9.5, the winner, but not a banger.
    await ratePlayback(pages, medias, (rater, song) =>
      song === 2 ? (rater === 0 ? 10 : 9) : 5,
    );
    const host = pages[0]!;
    // The show is rendered on `body`: watch every page for it for the whole
    // reveal, then check the entry carries no flag.
    await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const root = document.documentElement;
          root.dataset.bangerSeen = '0';
          new MutationObserver(() => {
            if (document.querySelector('[data-testid="banger-show"]')) {
              root.dataset.bangerSeen = String(
                Number(root.dataset.bangerSeen) + 1,
              );
            }
          }).observe(document.body, { childList: true, subtree: true });
        }),
      ),
    );
    await expect(host.getByTestId('jackpot-show')).toBeVisible({
      timeout: 15_000,
    });
    await expect(host.getByTestId('jackpot-show')).toBeHidden({
      timeout: 8000,
    });
    await expect(host.getByTestId('leaderboard')).toBeVisible();
    for (const page of pages) {
      expect(
        await page.evaluate(() => document.documentElement.dataset.bangerSeen),
      ).toBe('0');
      await expect(page.getByTestId('banger-show')).toHaveCount(0);
      await expect(page.getByTestId('reveal-entry-banger')).toHaveCount(0);
    }
    const entries = await host
      .getByTestId('reveal-entry')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-banger')),
      );
    expect(entries).toEqual(['false', 'false', 'false']);
  } finally {
    await closeStages(stages);
  }
});
