import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assembleRoom,
  closeStages,
  dispatch,
  newStage,
  setSettings,
  stateOf,
  unlockSound,
  waitForPhase,
  type Stage,
} from './m3-support';
import type { Media } from '../src/shared/primitives';
import {
  advanceToVoting,
  finishVoting,
  mediaFor,
  playToPlayback,
} from './m5-support';

/**
 * #26 / #69: automated WCAG 2.1 AA scan (SPEC section 6) of every screen of one
 * round through the in-memory harness: Home, Lobby, GENRE_SPIN, SUBMISSION,
 * PLAYBACK, VOTING, REVEAL and FINAL.
 *
 * The gate is zero `serious`/`critical` violations for the rule tags `wcag2a`,
 * `wcag2aa`, `wcag21a` and `wcag21aa` (axe-core's `wcag21aa` tag holds only the
 * rules added in 2.1, so the 2.0 tags are required alongside it). Reduced motion
 * is on so no entry animation or opacity transition is mid-flight while axe
 * samples colours; the contrast of a settled screen is what the gate measures.
 * Chromium only, as in the issue.
 */
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Finding {
  screen: string;
  rule: string;
  impact: string | null | undefined;
  node: string;
  why: string;
}

/**
 * Scans the page's current screen (a fresh builder per scan, as axe-playwright
 * requires) and records every serious/critical violation, so one run lists all
 * screens' findings instead of stopping at the first.
 */
async function scan(
  page: Page,
  screen: string,
  findings: Finding[],
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_AA_TAGS)
    .analyze();
  for (const { id, impact, nodes } of results.violations) {
    if (impact !== 'serious' && impact !== 'critical') {
      continue;
    }
    for (const { html, failureSummary } of nodes) {
      findings.push({
        screen,
        rule: id,
        impact,
        node: html.slice(0, 160),
        why: failureSummary ?? '',
      });
    }
  }
}

/** The desktop default of the harness and the 360 px phone of the redesign QA. */
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 740 };

const VARIANTS = [
  { name: 'en-US desktop', locale: 'en-US', viewport: DESKTOP },
  { name: 'de-DE desktop', locale: 'de-DE', viewport: DESKTOP },
  { name: 'de-DE 360 px', locale: 'de-DE', viewport: PHONE },
] as const;

for (const { name, locale, viewport } of VARIANTS) {
  test(`axe finds no serious or critical WCAG 2.1 AA violation on any screen (${name})`, async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'The axe gate runs in Chromium only');
    test.setTimeout(120_000);
    const stages = await Promise.all(
      ['Alice', 'Bob', 'Cara'].map((nickname) =>
        newStage(browser, {
          nickname,
          locale,
          viewport,
          reducedMotion: 'reduce',
        }),
      ),
    );
    try {
      const [host] = stages as [Stage, Stage, Stage];
      const findings: Finding[] = [];
      const players = stages.map((stage) => stage.page);

      await expect(host.page.getByTestId('home-forms')).toBeVisible();
      await scan(host.page, 'Home', findings);

      await assembleRoom(host, stages.slice(1));
      await setSettings(host.page, { rounds: 1 });
      await expect(host.page.getByTestId('roster')).toBeVisible();
      await scan(host.page, 'Lobby', findings);

      for (const page of players) {
        await unlockSound(page);
      }
      await host.page.getByTestId('start-game').click();
      await waitForPhase(host.page, 'GENRE_SPIN');
      await scan(host.page, 'GENRE_SPIN', findings);

      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
      await waitForPhase(host.page, 'SUBMISSION');
      await scan(host.page, 'SUBMISSION', findings);

      const medias = players.map((_, index) => mediaFor(1, index));
      for (const [index, page] of players.entries()) {
        expect(
          (await dispatch(page, { type: 'SUBMIT_SONG', media: medias[index] }))
            .status,
        ).toBe('accepted');
        expect(
          (await dispatch(page, { type: 'FINISH_SUBMISSION' })).status,
        ).toBe('accepted');
      }
      await waitForPhase(host.page, 'PLAYBACK');
      await scan(host.page, 'PLAYBACK', findings);

      await advanceToVoting(players);
      await scan(host.page, 'VOTING', findings);

      // Rank one song first so the ranked list, not only the empty pool, is scanned.
      const ranking = [(medias[1] as Media).videoId];
      expect(
        (await dispatch(host.page, { type: 'SET_RANKING', ranking })).status,
      ).toBe('accepted');
      await expect(host.page.getByTestId('voting-rank-item')).toHaveCount(
        ranking.length,
      );
      await scan(host.page, 'VOTING (ranked)', findings);

      await finishVoting(players, medias);
      await waitForPhase(host.page, 'REVEAL');
      await expect(host.page.getByTestId('reveal-phase')).toBeVisible();
      await scan(host.page, 'REVEAL', findings);

      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
      await waitForPhase(host.page, 'FINAL');
      await expect(host.page.getByTestId('final-phase')).toBeVisible();
      expect((await stateOf(host.page))?.phase.type).toBe('FINAL');
      await scan(host.page, 'FINAL', findings);

      expect(findings).toEqual([]);
    } finally {
      await closeStages(stages);
    }
  });
}

/**
 * The reveal's two shows: Alice and Bob submitted the same song (FR-26, the
 * Spiritually Linked card with the owner names) and Cara's solo song wins and
 * runs the jackpot (FR-60). Both are scanned while they are on screen.
 */
test('axe finds no serious or critical violation in the linked and jackpot reveal', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The axe gate runs in Chromium only');
  test.setTimeout(120_000);
  const stages = await Promise.all(
    ['Alice', 'Bob', 'Cara'].map((nickname) =>
      newStage(browser, { nickname, reducedMotion: 'reduce' }),
    ),
  );
  try {
    const pages = stages.map((stage) => stage.page);
    const host = pages[0] as Page;
    const findings: Finding[] = [];
    const dupe = mediaFor(1, 0);
    const solo = mediaFor(1, 2);
    await assembleRoom(stages[0] as Stage, stages.slice(1));
    await playToPlayback(pages, [dupe, dupe, solo]);
    await advanceToVoting(pages);
    const ballots: Array<[Page, string[]]> = [
      [pages[0] as Page, [solo.videoId]],
      [pages[1] as Page, [solo.videoId]],
      [pages[2] as Page, [dupe.videoId]],
    ];
    for (const [page, ranking] of ballots) {
      expect(
        (await dispatch(page, { type: 'SET_RANKING', ranking })).status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_VOTING' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host, 'REVEAL');

    await expect(host.getByTestId('linked-animation')).toBeVisible({
      timeout: 10_000,
    });
    await scan(host, 'REVEAL (linked)', findings);

    await expect(host.getByTestId('jackpot-show')).toBeVisible({
      timeout: 6000,
    });
    await scan(host, 'REVEAL (jackpot)', findings);

    await expect(host.getByTestId('jackpot-show')).toBeHidden({
      timeout: 5000,
    });
    await expect(host.getByTestId('leaderboard')).toBeVisible();
    await scan(host, 'REVEAL (settled)', findings);

    expect(findings).toEqual([]);
  } finally {
    await closeStages(stages);
  }
});
