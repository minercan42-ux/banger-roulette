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
  /**
   * True once the pixel face is loaded or, while it is still loading, once both
   * metric fallbacks are resolved. Until then the last-resort monospace face is
   * in use: Gecko and WebKit activate a `local()` @font-face one frame after the
   * first layout, so those frames paint the hero a line wider at 360 px, while
   * Chromium resolves such a face synchronously. See docs/OPEN_QUESTIONS.md
   * (#140).
   */
  settled: boolean;
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
    // The two faces the pixel typography falls back to (see the stylesheet):
    // while they are not resolved the last-resort monospace face is used.
    const metricFallbacks = ['Jersey 10 Fallback', 'Jersey 10 Fallback Caps'];
    const sample = (): void => {
      const field = document.querySelector(selector);
      if (field === null) return;
      const faceStates: Record<string, string> = {};
      document.fonts.forEach((face) => {
        faceStates[face.family.replaceAll('"', '')] = face.status;
      });
      samples.push({
        fieldTop: field.getBoundingClientRect().top,
        joining:
          document.querySelector('[data-testid="route-joining"]') !== null,
        notice:
          document.querySelector('[data-testid="identity-missing"]') !== null,
        settled:
          // The pixel face is in use as soon as it is loaded; before that the
          // metric fallbacks must be resolved, otherwise the last-resort
          // monospace face is in use and the hero wraps differently.
          faceStates['Jersey 10'] === 'loaded' ||
          metricFallbacks.every((family) => {
            const status = faceStates[family];
            return status === 'loaded' || status === 'error';
          }),
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
 * first layout with the settled typography (= the two metric fallbacks of the
 * pixel fonts are resolved, see `Sample.settled`) until the notice is visible.
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
    // Measured from the settled typography on (`Sample.settled`): the frames
    // before it are a first-paint reflow of the browser's last-resort face, not
    // the notice insertion or the pixel-font swap this spec is about. Both stay
    // fully inside the measured window: the notice appears while the identity
    // check resolves and the pixel-font swap is held back until after the first
    // sampled frame, so the 1 px rule below applies to both.
    const settled = samples.filter((entry) => entry.settled);
    const before = settled.filter((entry) => entry.joining && !entry.notice);
    const after = settled.filter((entry) => entry.notice);
    expect(samples.filter((entry) => !entry.settled && entry.notice)).toEqual(
      [],
    );
    expect(settled.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    const reference = before[0].fieldTop;
    const moved = settled.filter(
      (entry) => Math.abs(entry.fieldTop - reference) > 1,
    );
    if (moved.length > 0) {
      console.log(`deep link samples: ${JSON.stringify(samples)}`);
    }
    expect(moved).toEqual([]);

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
    // The pixel faces load right after the first layout; measure through the
    // swap, not just up to the first visible form.
    await page.waitForFunction(() =>
      [...document.fonts].some(
        (face) =>
          face.family.replaceAll('"', '') === 'Jersey 10' &&
          (face.status === 'loaded' || face.status === 'error'),
      ),
    );
    await page.waitForTimeout(300);

    const samples = await page.evaluate(() => window.__homeSamples ?? []);
    // Same window as `expectStableForms`: from the settled typography on.
    const settled = samples.filter((entry) => entry.settled);
    expect(settled.length).toBeGreaterThan(0);
    const reference = settled[0].fieldTop;
    const moved = settled.filter(
      (entry) => Math.abs(entry.fieldTop - reference) > 1,
    );
    if (moved.length > 0) {
      console.log(`plain home samples: ${JSON.stringify(samples)}`);
    }
    expect(moved).toEqual([]);
  } finally {
    await context.close();
  }
});
