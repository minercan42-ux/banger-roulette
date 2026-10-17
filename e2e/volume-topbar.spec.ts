import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assembleRoom,
  closeStages,
  enterSubmission,
  newStage,
  startPlayingPreview,
  submitSongViaUi,
  waitForPhase,
} from './m3-support';
import { waitForPlaybackState } from './m4-support';
import { youTubeCalls } from './youtube-fixture';

/**
 * Issue #107: the volume control lives in the top bar, in every phase. It owns
 * the playback volume/mute state that the PLAYBACK panel used to hold, and it
 * also drives the submission preview player.
 */
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const SONG_A = 'dQw4w9WgXcQ';
const SONG_B = 'kJQP7kiw5Fk';
const SONG_C = '3JZ_D3ELwOQ';

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

async function openPopover(page: Page): Promise<void> {
  const toggle = page.getByTestId('volume-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(page.getByTestId('volume-popover')).toBeVisible();
}

test('desktop: speaker at the right end of the top bar, popover by mouse and keyboard', async ({
  browser,
}) => {
  const stage = await newStage(browser, {
    nickname: 'Ada',
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  try {
    const page = stage.page;
    const mute = page.getByTestId('playback-mute');
    const toggle = page.getByTestId('volume-toggle');
    const popover = page.getByTestId('volume-popover');
    const slider = page.getByTestId('playback-volume');

    // Top right of the bar, next to the SFX toggle and the language switch.
    const header = (await page.locator('header').first().boundingBox())!;
    const control = (await page.getByTestId('volume-control').boundingBox())!;
    expect(control.x + control.width).toBeGreaterThanOrEqual(
      header.x + header.width - 24,
    );
    expect(control.y).toBeGreaterThanOrEqual(header.y);
    expect(control.y + control.height).toBeLessThanOrEqual(
      header.y + header.height,
    );
    const language = (await page.getByTestId('language-switch').boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(language.x + language.width);

    await expect(mute).toBeVisible();
    await expect(popover).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-label', 'Adjust volume');
    await expect(mute).toHaveAttribute('aria-label', 'Mute');

    // Keyboard: the opener works with Enter, the slider with the arrow keys.
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(slider).toHaveAttribute('aria-valuetext', '70 percent');
    await expect(slider).toHaveAttribute('data-value', '70');
    await expect(mute).toHaveAttribute('data-level', 'high');

    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('data-value', '69');
    await expect(slider).toHaveAttribute('aria-valuetext', '69 percent');
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('data-value', '0');
    await expect(mute).toHaveAttribute('data-level', 'muted');
    await slider.fill('30');
    await expect(mute).toHaveAttribute('data-level', 'low');
    await expect(page.getByTestId('volume-value')).toHaveText('30');
    await slider.fill('80');
    await expect(mute).toHaveAttribute('data-level', 'high');

    // Axe on the open popover (settled, reduced motion).
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_AA_TAGS)
      .analyze();
    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);

    // Esc closes and hands focus back to the opener.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // An outside press closes it as well.
    await openPopover(page);
    await page.getByTestId('app-title').click();
    await expect(popover).toBeHidden();

    // Tabbing out of the control closes it.
    await openPopover(page);
    await page.getByTestId('volume-popover-mute').focus();
    await page.keyboard.press('Tab');
    await expect(popover).toBeHidden();

    // The speaker toggles mute; the popover checkbox mirrors it.
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await mute.click();
    await expect(mute).toHaveAttribute('data-muted', 'true');
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(mute).toHaveAttribute('data-level', 'muted');
    await openPopover(page);
    await expect(page.getByTestId('volume-popover-mute')).toBeChecked();
    await page.getByTestId('volume-popover-mute').uncheck();
    await expect(mute).toHaveAttribute('data-muted', 'false');
    await expect(slider).toHaveAttribute('data-value', '80');

    // A speaker that shows "off" at volume 0 comes back audible on click.
    await slider.fill('0');
    await expect(mute).toHaveAttribute('data-level', 'muted');
    await mute.click();
    await expect(slider).toHaveAttribute('data-value', '70');
    await expect(mute).toHaveAttribute('data-level', 'high');

    // In memory only: no new storage key (privacy notice unchanged).
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keys.filter((key) => /volume|mute/i.test(key))).toEqual([]);
  } finally {
    await closeStages([stage]);
  }
});

test('360 px: the speaker sits in the top bar and the popover fits the viewport', async ({
  browser,
}) => {
  const stage = await newStage(browser, {
    nickname: 'Ada',
    viewport: { width: 360, height: 740 },
    reducedMotion: 'reduce',
  });
  try {
    const page = stage.page;
    const header = (await page.locator('header').first().boundingBox())!;
    const control = (await page.getByTestId('volume-control').boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(360);
    expect(control.y).toBeGreaterThanOrEqual(header.y);
    expect(control.y + control.height).toBeLessThanOrEqual(
      header.y + header.height + 1,
    );

    await openPopover(page);
    // The phone bar hides labels inside its controls; the popover keeps its own.
    await expect(
      page.getByTestId('volume-popover').getByText('Volume', { exact: true }),
    ).toBeVisible();
    const popover = (await page.getByTestId('volume-popover').boundingBox())!;
    expect(popover.x).toBeGreaterThanOrEqual(0);
    expect(popover.x + popover.width).toBeLessThanOrEqual(360);
    expect(popover.y + popover.height).toBeLessThanOrEqual(740);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    const slider = page.getByTestId('playback-volume');
    await slider.fill('25');
    await expect(page.getByTestId('playback-mute')).toHaveAttribute(
      'data-level',
      'low',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('volume-popover')).toBeHidden();
  } finally {
    await closeStages([stage]);
  }
});

test('the control drives the preview and the playback player; the panel slider is gone', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Ada' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const host = stages[0]!.page;
    await assembleRoom(stages[0]!, stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));

    // Preview: the value chosen before loading reaches the preview player and
    // follows later changes.
    await openPopover(host);
    await host.getByTestId('playback-volume').fill('33');
    await expect(host.getByTestId('playback-volume')).toHaveAttribute(
      'data-value',
      '33',
    );
    await startPlayingPreview(host, watchUrl(SONG_A));
    await expect
      .poll(async () =>
        (await youTubeCalls(host)).some(
          (call) => call.type === 'volume' && call.value === 33,
        ),
      )
      .toBe(true);
    await openPopover(host);
    await host.getByTestId('playback-volume').fill('21');
    await expect
      .poll(async () => {
        const volumes = (await youTubeCalls(host)).filter(
          (call) => call.type === 'volume',
        );
        return volumes.at(-1)?.value;
      })
      .toBe(21);

    await submitSongViaUi(host, watchUrl(SONG_A));
    await submitSongViaUi(stages[1]!.page, watchUrl(SONG_B));
    await submitSongViaUi(stages[2]!.page, watchUrl(SONG_C));
    for (const stage of stages) {
      await stage.page.getByTestId('finish-submission').click();
    }
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'PLAYBACK', 30000)),
    );
    await waitForPlaybackState(host, 'playing', 30000);

    // Panel slider and mute checkbox are gone; the bar control is the only one.
    await expect(
      host.getByTestId('playback-phase').getByTestId('playback-volume'),
    ).toHaveCount(0);
    await expect(
      host.getByTestId('playback-phase').getByTestId('playback-mute'),
    ).toHaveCount(0);
    await expect(host.getByTestId('playback-volume')).toHaveCount(1);
    await expect(host.getByTestId('playback-mute')).toHaveCount(1);
    await expect(host.getByTestId('playback-mute')).toBeVisible();

    const lastAudio = async (type: 'volume' | 'mute' | 'unmute') =>
      (await youTubeCalls(host)).filter((call) => call.type === type).at(-1);

    // The playing video follows the slider ...
    await openPopover(host);
    await host.getByTestId('playback-volume').fill('15');
    await expect.poll(async () => (await lastAudio('volume'))?.value).toBe(15);

    // ... and the speaker mutes and unmutes it.
    const before = (await youTubeCalls(host)).length;
    await host.getByTestId('playback-mute').click();
    await expect
      .poll(async () => (await youTubeCalls(host)).slice(before))
      .toContainEqual(expect.objectContaining({ type: 'mute' }));
    const afterMute = (await youTubeCalls(host)).length;
    await host.getByTestId('playback-mute').click();
    await expect
      .poll(async () => (await youTubeCalls(host)).slice(afterMute))
      .toContainEqual(expect.objectContaining({ type: 'unmute' }));
  } finally {
    await closeStages(stages);
  }
});
