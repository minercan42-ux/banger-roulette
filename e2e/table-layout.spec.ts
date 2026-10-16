import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assembleRoom,
  closeStages,
  enterSubmission,
  newStage,
  type Stage,
} from './m3-support';

/**
 * Issue #86, Spieltisch layout: full-width table at 1280 px, roster strip in
 * between, sticky bars and a keyboard-accessible drawer at 360 px. Placement
 * only; the game flows are covered by the suites that own them.
 */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

async function box(page: Page, testId: string): Promise<Box> {
  const found = await page.getByTestId(testId).first().boundingBox();
  if (found === null) {
    throw new Error(`${testId} has no box`);
  }
  return {
    left: found.x,
    right: found.x + found.width,
    top: found.y,
    bottom: found.y + found.height,
    width: found.width,
  };
}

async function mainBox(page: Page): Promise<Box> {
  const found = await page.locator('main').boundingBox();
  if (found === null) {
    throw new Error('main has no box');
  }
  return {
    left: found.x,
    right: found.x + found.width,
    top: found.y,
    bottom: found.y + found.height,
    width: found.width,
  };
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/** True when the element's centre is the top-most thing at that point. */
async function uncovered(page: Page, testId: string): Promise<boolean> {
  const target = page.getByTestId(testId);
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && element.contains(hit);
  });
}

async function hostRoom(
  browser: Parameters<typeof newStage>[0],
  viewport: { width: number; height: number },
  guests = 1,
): Promise<{ host: Stage; stages: Stage[] }> {
  const names = ['Ada', 'Bob', 'Cleo', 'Dario'];
  const stages = await Promise.all(
    names
      .slice(0, guests + 1)
      .map((nickname) => newStage(browser, { nickname, viewport })),
  );
  const [host, ...rest] = stages as [Stage, ...Stage[]];
  await assembleRoom(host, rest);
  return { host, stages };
}

test('1280 px: top bar spans the width, roster sits beside the stage', async ({
  browser,
}) => {
  const { host, stages } = await hostRoom(browser, {
    width: 1280,
    height: 800,
  });
  try {
    const page = host.page;
    const viewport = 1280;
    const top = await page.locator('header').first().boundingBox();
    expect(top).not.toBeNull();
    // Full width: only the page gutter is left on each side.
    expect(top!.width).toBeGreaterThanOrEqual(viewport - 48);

    const roster = await box(page, 'roster-section');
    const stage = await mainBox(page);
    // Beside, not above: the roster column ends before the stage starts and
    // both begin at the same height.
    expect(roster.right).toBeLessThanOrEqual(stage.left);
    expect(Math.abs(roster.top - stage.top)).toBeLessThanOrEqual(8);
    // The stage takes the remaining width instead of a centred column.
    expect(stage.width).toBeGreaterThan(viewport * 0.6);
    expect(roster.width).toBeLessThanOrEqual(260);

    // Actions bar sits under the stage, aligned with it.
    const actions = await box(page, 'table-actions');
    expect(actions.top).toBeGreaterThanOrEqual(stage.bottom - 1);
    expect(Math.abs(actions.left - stage.left)).toBeLessThanOrEqual(2);

    // No dialog chrome on the table: the drawer content is inline.
    await expect(page.getByTestId('drawer-toggle')).toBeHidden();
    await expect(page.getByTestId('lobby-readiness')).toBeVisible();
    await expect(page.getByTestId('privacy-notice')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await closeStages(stages);
  }
});

test('800 px: the roster collapses into a horizontal strip above the stage', async ({
  browser,
}) => {
  const { host, stages } = await hostRoom(
    browser,
    { width: 800, height: 900 },
    2,
  );
  try {
    const page = host.page;
    const roster = await box(page, 'roster-section');
    const stage = await mainBox(page);
    expect(roster.bottom).toBeLessThanOrEqual(stage.top);

    const rows = page.getByTestId('roster-row');
    await expect(rows).toHaveCount(3);
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // One line of cards: same top, the next card starts to the right.
    expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(2);
    expect(second!.x).toBeGreaterThan(first!.x);
    await expect(page.getByTestId('drawer-toggle')).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await closeStages(stages);
  }
});

test('360 px: sticky bars leave controls reachable and nothing overflows', async ({
  browser,
}) => {
  const { host, stages } = await hostRoom(
    browser,
    { width: 360, height: 740 },
    2,
  );
  try {
    const page = host.page;
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // Both bars stay on screen while the page scrolls.
    await page.evaluate(() => window.scrollTo(0, 300));
    const header = await page.locator('header').first().boundingBox();
    expect(header!.y).toBeLessThanOrEqual(1);
    const actions = await box(page, 'table-actions');
    expect(actions.bottom).toBeGreaterThanOrEqual(740 - 1);
    expect(actions.bottom).toBeLessThanOrEqual(740 + 1);

    // A control scrolled into view is never hidden behind either bar.
    for (const testId of ['sound-consent', 'copy-link', 'leave-room']) {
      expect(await uncovered(page, testId), `${testId} is covered`).toBe(true);
    }
    await page.getByTestId('roster').scrollIntoViewIfNeeded();
    const roster = page.getByTestId('roster');
    const scrollable = await roster.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(scrollable).toBe(true);
    await expect(page.getByTestId('privacy-notice')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await closeStages(stages);
  }
});

test('360 px: the drawer is a keyboard-accessible dialog', async ({
  browser,
}) => {
  const { host, stages } = await hostRoom(
    browser,
    { width: 360, height: 740 },
    2,
  );
  try {
    const page = host.page;
    await enterSubmission(stages.map((stage) => stage.page));
    // Outside the lobby the sound status lives in the drawer.
    const drawer = page.getByTestId('table-drawer');
    await expect(drawer).toBeHidden();
    const toggle = page.getByTestId('drawer-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('drawer-close')).toBeFocused();
    await expect(page.getByTestId('sound-status')).toBeVisible();

    // Moving the control from the stage to the drawer keeps the permission
    // enabled in the lobby: no second click, one control, roster agrees.
    await expect(page.getByTestId('sound-control')).toHaveCount(1);
    await expect(drawer.getByTestId('sound-control')).toHaveCount(1);
    await expect(page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );
    await expect(page.getByTestId('sound-consent')).toHaveCount(0);
    await expect(
      page
        .locator('[data-testid="roster-row"][data-self="true"]')
        .getByTestId('player-sound-status'),
    ).toHaveAttribute('data-unlocked', 'true');

    // Tab and Shift+Tab wrap inside the dialog.
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        document
          .querySelector('[data-testid="table-drawer"]')!
          .contains(document.activeElement),
      );
      expect(inside, `Tab step ${step} stays in the dialog`).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.evaluate(() =>
        document
          .querySelector('[data-testid="table-drawer"]')!
          .contains(document.activeElement),
      ),
    ).toBe(true);

    // Esc closes and focus returns to the opener.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // The scrim closes it too.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await page
      .getByTestId('drawer-scrim')
      .click({ position: { x: 4, y: 300 } });
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
  } finally {
    await closeStages(stages);
  }
});
