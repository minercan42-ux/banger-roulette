import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { harnessContext } from './m3-support';

const TITLE = 'Banger Roulette';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function visibleShellText(page: Page): Promise<string> {
  const text = await page.locator('body').innerText();
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The bilingual shell contract that survives every milestone: the product name
 * stays visible, the language switch keeps its stable test id, the document
 * language reflects the selection and the title never localizes.
 */
async function expectShell(page: Page, lang: string): Promise<void> {
  await expect(
    page.locator('body').getByText(TITLE, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByTestId('language-switch')).toHaveValue(lang);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page).toHaveTitle(TITLE);
}

/** Writes a token onto the live document to detect any reload. */
async function writeDocumentToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const token = Math.random().toString(36).slice(2);
    (window as unknown as Record<string, unknown>).__shellToken = token;
    return token;
  });
}

async function readDocumentToken(page: Page): Promise<unknown> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>).__shellToken,
  );
}

test('three isolated contexts render the bilingual shell', async ({
  browser,
}) => {
  const [de, en, fr] = await Promise.all([
    harnessContext(browser, { locale: 'de-DE' }),
    harnessContext(browser, { locale: 'en-US' }),
    harnessContext(browser, { locale: 'fr-FR' }),
  ]);
  try {
    const [dePage, enPage, frPage] = await Promise.all([
      de.newPage(),
      en.newPage(),
      fr.newPage(),
    ]);
    const deErrors = trackErrors(dePage);
    const enErrors = trackErrors(enPage);
    const frErrors = trackErrors(frPage);

    await Promise.all([dePage.goto('/'), enPage.goto('/'), frPage.goto('/')]);

    await expectShell(dePage, 'de');
    await expectShell(enPage, 'en');
    // fr-FR is unsupported and must fall back to German.
    await expectShell(frPage, 'de');

    // The visible shell copy is localized; the fallback matches German.
    const deText = await visibleShellText(dePage);
    const enText = await visibleShellText(enPage);
    const frText = await visibleShellText(frPage);
    expect(deText.trim()).not.toBe('');
    expect(enText.trim()).not.toBe('');
    expect(deText).not.toBe(enText);
    // The unsupported locale renders exactly the German fallback shell.
    expect(frText).toBe(deText);

    const deSelect = dePage.getByTestId('language-switch');
    const enSelect = enPage.getByTestId('language-switch');

    const deOptions = await deSelect.locator('option').allTextContents();
    const enOptions = await enSelect.locator('option').allTextContents();
    expect([...deOptions].sort()).toEqual(['Deutsch', 'English']);
    expect([...enOptions].sort()).toEqual(['Deutsch', 'English']);

    // The accessible name is localized, so it must differ between locales.
    const deLabel = await deSelect.getAttribute('aria-label');
    const enLabel = await enSelect.getAttribute('aria-label');
    expect(deLabel).toBeTruthy();
    expect(enLabel).toBeTruthy();
    expect(deLabel).not.toBe(enLabel);

    expect(deErrors).toEqual([]);
    expect(enErrors).toEqual([]);
    expect(frErrors).toEqual([]);
  } finally {
    await Promise.all([de.close(), en.close(), fr.close()]);
  }
});

test('language switch updates html lang and shell text without reload', async ({
  browser,
}) => {
  const context = await harnessContext(browser, { locale: 'de-DE' });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto('/');
    const select = page.getByTestId('language-switch');
    await expectShell(page, 'de');

    const token = await writeDocumentToken(page);
    const beforeText = await visibleShellText(page);

    await select.selectOption('en');
    await expectShell(page, 'en');

    expect(await readDocumentToken(page)).toBe(token);
    const afterText = await visibleShellText(page);
    expect(afterText).not.toBe(beforeText);

    await select.selectOption('de');
    await expectShell(page, 'de');
    expect(await readDocumentToken(page)).toBe(token);
    expect(await visibleShellText(page)).toBe(beforeText);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('keyboard changes the language selection', async ({ browser }) => {
  const context = await harnessContext(browser, { locale: 'de-DE' });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto('/');
    const select = page.getByTestId('language-switch');
    await expect(select).toHaveValue('de');

    await select.focus();
    await page.keyboard.press('ArrowDown');
    await expect(select).not.toHaveValue('de');

    const selected = await select.inputValue();
    await expect(page.locator('html')).toHaveAttribute('lang', selected);
    await expect(page).toHaveTitle(TITLE);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('deep link /r/ABCDEF loads the shell and survives a reload', async ({
  browser,
}) => {
  const context = await harnessContext(browser, { locale: 'en-US' });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    const first = await page.goto('/r/ABCDEF');
    expect(first?.status()).toBe(200);
    await expectShell(page, 'en');

    const reloaded = await page.reload();
    // Firefox reports the 304 of the conditional reload (the dev server answers
    // `If-None-Match` with `304 Not Modified`) while Chromium surfaces the
    // cached 200 for the same reload. Both render the shell, the assertion below.
    expect([200, 304]).toContain(reloaded?.status());
    await expectShell(page, 'en');

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('shell has no horizontal overflow at 360px', async ({ browser }) => {
  const context = await harnessContext(browser, {
    locale: 'de-DE',
    viewport: { width: 360, height: 640 },
  });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto('/');
    await expectShell(page, 'de');

    const widths = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(widths.documentScrollWidth).toBeLessThanOrEqual(widths.innerWidth);
    expect(widths.bodyScrollWidth).toBeLessThanOrEqual(widths.innerWidth);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('shell honours a reduced motion preference', async ({ browser }) => {
  const context = await harnessContext(browser, {
    locale: 'de-DE',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto('/');
    await expectShell(page, 'de');

    await expect
      .poll(async () =>
        page.evaluate(
          () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      )
      .toBe(true);

    // With reduced motion requested no element may run a CSS animation.
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

const PRIVACY = {
  de: {
    title: 'Datenschutz',
    embed: 'youtube-nocookie.com eingebettet',
    noTracking: 'keine Analyse-Tools und setzt keine Cookies',
    storage: 'zufällige Spieler-ID im localStorage',
  },
  en: {
    title: 'Privacy',
    embed: 'embedded from youtube-nocookie.com',
    noTracking: 'no analytics and sets no cookies',
    storage: 'random player ID in your browser',
  },
} as const;

async function expectPrivacyNotice(
  page: Page,
  lang: keyof typeof PRIVACY,
): Promise<void> {
  const notice = page.getByTestId('privacy-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(PRIVACY[lang].title);
  await expect(notice).toContainText(PRIVACY[lang].embed);
  await expect(notice).toContainText(PRIVACY[lang].noTracking);
  await expect(notice).toContainText(PRIVACY[lang].storage);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    noticeRight: document
      .querySelector('[data-testid="privacy-notice"]')!
      .getBoundingClientRect().right,
  }));
  expect(widths.documentScrollWidth).toBeLessThanOrEqual(widths.innerWidth);
  expect(widths.noticeRight).toBeLessThanOrEqual(widths.innerWidth);
}

test('privacy notice shows on Home and in a room and switches language without reload', async ({
  browser,
}) => {
  const context = await harnessContext(browser, {
    locale: 'de-DE',
    viewport: { width: 360, height: 740 },
  });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto('/');
    await page.waitForFunction(() => window.__banger !== undefined);

    // Home, German by default.
    await expectPrivacyNotice(page, 'de');
    await expectNoHorizontalOverflow(page);

    // The footer follows the language switch without a reload.
    const token = await writeDocumentToken(page);
    await page.getByTestId('language-switch').selectOption('en');
    await expectPrivacyNotice(page, 'en');
    expect(await readDocumentToken(page)).toBe(token);
    await expectNoHorizontalOverflow(page);

    // In a room the same footer stays on screen.
    await page.getByTestId('create-nickname').fill('Alice');
    await page.getByTestId('create-room').click();
    await expect(page.getByTestId('room-view')).toBeVisible();
    await expect(page.getByTestId('privacy-notice')).toHaveCount(1);
    await expectPrivacyNotice(page, 'en');
    await expectNoHorizontalOverflow(page);

    await page.getByTestId('language-switch').selectOption('de');
    await expectPrivacyNotice(page, 'de');
    expect(await readDocumentToken(page)).toBe(token);
    await expectNoHorizontalOverflow(page);

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
