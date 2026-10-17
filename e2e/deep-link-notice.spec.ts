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
 * Records the nickname field's top at every DOM commit and painted frame, starting before the app
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
    const frame = (): void => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
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

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 360, height: 740 },
];

/**
 * Opens `/r/<code>` as a new visitor and checks the forms never move from the
 * first sampled layout until the notice is visible.
 *
 * `realFonts` keeps the production typography: the pixel fonts are held back
 * until the form was painted and the clock response is slow, so first paint
 * happens in the fallback face and the swap lands while the identity check is
 * still running.
 * Otherwise the font requests are aborted, which isolates the notice insertion.
 */
async function expectStableForms(
  browser: Browser,
  options: {
    locale: 'en-US' | 'de-DE';
    viewport: { width: number; height: number };
    realFonts: boolean;
  },
): Promise<void> {
  const room = await openRoom(browser);
  const pageRef: { current: Page | null } = { current: null };
  // A fresh context holds no client id, so the identity check finds nothing.
  const context = await harnessContext(browser, {
    locale: options.locale,
    viewport: options.viewport,
  });
  try {
    if (options.realFonts) {
      // The faces arrive only once the form has been painted, and the clock
      // answer is slow enough for the swap to land while the identity check
      // still runs: the worst order a slow connection can produce.
      await context.route('**/fonts/*.woff2', async (route) => {
        await expect
          .poll(() =>
            pageRef.current?.evaluate(() => window.__homeSamples?.length ?? 0),
          )
          .toBeGreaterThan(0);
        await route.continue();
      });
      await context.route('**/api/time', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.continue();
      });
    } else {
      await context.route('**/fonts/*.woff2', (route) => route.abort());
    }
    const page = await context.newPage();
    pageRef.current = page;
    await recordFieldTop(page);
    await page.goto(`/r/${room.code}`);

    const notice = page.getByTestId('identity-missing');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('route-joining')).toHaveCount(0);
    if (options.realFonts) {
      await page.evaluate(() => document.fonts.ready);
      // Let the swap and any resulting frames land before reading the samples.
      await page.waitForTimeout(300);
    }

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
}

for (const viewport of VIEWPORTS) {
  for (const locale of ['en-US', 'de-DE'] as const) {
    test(`deep link notice does not move the forms with the real fonts at ${viewport.width}px (${locale})`, async ({
      browser,
    }) => {
      await expectStableForms(browser, { locale, viewport, realFonts: true });
    });
  }

  test(`deep link notice does not move the forms at ${viewport.width}px`, async ({
    browser,
  }) => {
    await expectStableForms(browser, {
      locale: 'en-US',
      viewport,
      realFonts: false,
    });
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
