import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createRoom, harnessContext } from './m3-support';

/**
 * #83: on a deep link /r/<code> a new visitor gets the "enter a nickname"
 * notice once the identity check resolves. The forms must not move when it
 * appears (CLS), and the notice must not cover an input.
 */

interface Sample {
  fieldTop: number;
  joining: boolean;
  notice: boolean;
}

declare global {
  interface Window {
    __homeSamples?: Sample[];
  }
}

const FIELD = '[data-testid="create-nickname"]';

/**
 * Records the nickname field's top at every DOM commit, starting before the app
 * mounts, so the states before and after the identity check are both captured
 * however fast the check resolves.
 */
async function recordFieldTop(page: Page): Promise<void> {
  await page.addInitScript((selector) => {
    const samples: Sample[] = [];
    window.__homeSamples = samples;
    const sample = (): void => {
      const field = document.querySelector(selector);
      if (field === null) return;
      samples.push({
        fieldTop: field.getBoundingClientRect().top,
        joining:
          document.querySelector('[data-testid="route-joining"]') !== null,
        notice:
          document.querySelector('[data-testid="identity-missing"]') !== null,
      });
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }, FIELD);
}

async function openRoom(browser: Browser): Promise<{
  code: string;
  close: () => Promise<void>;
}> {
  const hostContext = await harnessContext(browser, { locale: 'en-US' });
  const host = await hostContext.newPage();
  await host.goto('/');
  await host.waitForFunction(() => window.__banger !== undefined);
  const code = await createRoom(host, 'Alice');
  return { code, close: () => hostContext.close() };
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 360, height: 740 },
]) {
  test(`deep link notice does not move the forms at ${viewport.width}px`, async ({
    browser,
  }) => {
    const room = await openRoom(browser);
    // A fresh context holds no client id, so the identity check finds nothing.
    const context = await harnessContext(browser, {
      locale: 'en-US',
      viewport,
    });
    // The pixel fonts swap in after first paint and reflow the heading; that is
    // a separate shift. Keep the fallback fonts so only the notice can move
    // the forms.
    await context.route('**/fonts/*.woff2', (route) => route.abort());
    try {
      const page = await context.newPage();
      await recordFieldTop(page);
      await page.goto(`/r/${room.code}`);

      const notice = page.getByTestId('identity-missing');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(page.getByTestId('route-joining')).toHaveCount(0);

      const samples = await page.evaluate(() => window.__homeSamples ?? []);
      const before = samples.filter((entry) => entry.joining && !entry.notice);
      const after = samples.filter((entry) => entry.notice);
      expect(before.length).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);
      const reference = before[0].fieldTop;
      for (const entry of samples) {
        expect(Math.abs(entry.fieldTop - reference)).toBeLessThanOrEqual(1);
      }

      const noticeBox = await notice.boundingBox();
      expect(noticeBox).not.toBeNull();
      for (const id of ['create-nickname', 'join-code', 'join-nickname']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box).not.toBeNull();
        const overlaps =
          noticeBox!.x < box!.x + box!.width &&
          box!.x < noticeBox!.x + noticeBox!.width &&
          noticeBox!.y < box!.y + box!.height &&
          box!.y < noticeBox!.y + noticeBox!.height;
        expect(overlaps, `${id} overlaps the notice`).toBe(false);
      }
    } finally {
      await context.close();
      await room.close();
    }
  });
}

test('plain Home reserves no notice slot', async ({ browser }) => {
  const context = await harnessContext(browser, { locale: 'en-US' });
  try {
    const page = await context.newPage();
    await recordFieldTop(page);
    await page.goto('/');
    await expect(page.getByTestId('home-forms')).toBeVisible();
    await expect(page.getByTestId('identity-missing')).toHaveCount(0);
    await expect(
      page.getByTestId('home-forms').locator('.br-notice'),
    ).toHaveCount(0);

    const samples = await page.evaluate(() => window.__homeSamples ?? []);
    expect(samples.length).toBeGreaterThan(0);
    for (const entry of samples) {
      expect(
        Math.abs(entry.fieldTop - samples[0].fieldTop),
      ).toBeLessThanOrEqual(1);
    }
  } finally {
    await context.close();
  }
});
