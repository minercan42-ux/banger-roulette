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
        // A pause is only in effect once the next frame has committed it: a
        // pending pause still reports `paused` while its time keeps running.
        await expect
          .poll(() =>
            host.evaluate(
              () =>
                document
                  .querySelector('[data-testid="banger-show"]')
                  ?.getAnimations({ subtree: true })
                  .some((animation) => animation.pending) ?? false,
            ),
          )
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

const TWO_A = 'm8twoa00006';
const TWO_B = 'm8twob00007';
const TWO_C = 'm8twoc00008';

declare global {
  interface Window {
    /** Test probe: when tones of the banger finale were scheduled (ms). */
    __bangerStarts?: number[];
  }
}

for (const reducedMotion of [false, true] as const) {
  test(`two bangers in one round: the show runs once, both entries keep the badge (${reducedMotion ? 'reduced motion' : 'full motion'})`, async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const stages = await openStages(
      browser,
      reducedMotion ? 'reduce' : 'no-preference',
    );
    try {
      const pages = stages.map((stage) => stage.page);
      // Alice's and Bob's songs get a 10 from everybody else (two bangers, both
      // winners at 10.0); Cara's song gets a 4 and is revealed first.
      const medias = [mediaOf(TWO_A), mediaOf(TWO_B), mediaOf(TWO_C)];
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, medias);
      // The show is rendered on `body`: count its mounts on every client for
      // the whole reveal, not just whether it is visible at a given moment.
      await Promise.all(
        pages.map((page) =>
          page.evaluate(() => {
            const root = document.documentElement;
            root.dataset.bangerMounts = '0';
            new MutationObserver((records) => {
              for (const record of records) {
                for (const node of record.addedNodes) {
                  if (
                    node instanceof Element &&
                    (node.matches('[data-testid="banger-show"]') ||
                      node.querySelector('[data-testid="banger-show"]') !==
                        null)
                  ) {
                    root.dataset.bangerMounts = String(
                      Number(root.dataset.bangerMounts) + 1,
                    );
                  }
                }
              }
            }).observe(document.body, { childList: true, subtree: true });
            // Count the banger sound too: a tone scheduled more than 3.5 s
            // ahead is part of the banger finale and of nothing else.
            const starts: number[] = [];
            window.__bangerStarts = starts;
            const nativeStart = AudioScheduledSourceNode.prototype.start;
            AudioScheduledSourceNode.prototype.start = function (
              this: AudioScheduledSourceNode,
              when?: number,
            ) {
              if ((when ?? 0) - this.context.currentTime > 3.5) {
                starts.push(performance.now());
              }
              return nativeStart.call(this, when);
            };
          }),
        ),
      );
      await ratePlayback(pages, medias, (_rater, song) =>
        song === 2 ? 4 : 10,
      );

      // A pause inside the first show and a resume must neither remount the
      // show nor replay its sound (the resumed render must use a fresh clock).
      const host = pages[0]!;
      await expect(host.getByTestId('banger-show')).toBeVisible({
        timeout: 10_000,
      });
      await host.waitForTimeout(800);
      expect((await dispatch(host, { type: 'PAUSE' })).status).toBe('accepted');
      await host.waitForTimeout(2000);
      expect(
        (await dispatch(host, { type: 'RESUME', forceBelowMinimum: false }))
          .status,
      ).toBe('accepted');

      const entries = host.getByTestId('reveal-entry');
      await expect(host.getByTestId('leaderboard')).toBeVisible({
        timeout: 25_000,
      });
      // The second banger entry is the last one: no show for it, on any client.
      await expect(entries).toHaveCount(3);
      await host.waitForTimeout(1500);
      for (const page of pages) {
        expect(
          await page.evaluate(
            () => document.documentElement.dataset.bangerMounts,
          ),
        ).toBe('1');
        // One banger sound over the whole reveal: tones scheduled seconds
        // ahead (the banger finale) only come from the banger recipe, and one
        // play schedules them in one burst.
        expect(
          await page.evaluate(() => {
            const starts = window.__bangerStarts ?? [];
            return starts.filter(
              (at, index) => index === 0 || at - starts[index - 1]! > 1000,
            ).length;
          }),
        ).toBe(1);
        await expect(page.getByTestId('banger-show')).toHaveCount(0);
        await expect(page.getByTestId('jackpot-show')).toHaveCount(0);
      }
      expect(
        await entries.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-banger')),
        ),
      ).toEqual(['false', 'true', 'true']);
      await expect(host.getByTestId('reveal-entry-banger')).toHaveCount(2);
      for (const videoId of [TWO_A, TWO_B]) {
        await expect(
          host
            .locator(`[data-testid="reveal-entry"][data-video-id="${videoId}"]`)
            .getByTestId('reveal-entry-banger'),
        ).toHaveCount(1);
      }
      // The first banger had the 5 s slot, the second one a normal 2.5 s slot
      // (a plain 2.5 s entry first): 2500 + 5000 + 2500 + the 5000 ms hold.
      const phase = (await stateOf(host))?.phase;
      expect(
        phase?.type === 'REVEAL' ? phase.deadlineAt - phase.startedAt : null,
      ).toBe(2500 + 5000 + 2500 + 5000);
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
