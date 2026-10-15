import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  openUnderProductionCsp,
  PRODUCTION_CSP,
  routeWithProductionCsp,
} from './csp-policy';

/**
 * Regression test for #43.
 *
 * zod probes for `eval` support with `new Function("")` the first time a schema
 * is built. Under the production Content-Security-Policy (`script-src 'self'`,
 * no `'unsafe-eval'`) the browser reports that swallowed probe as a
 * `securitypolicyviolation` on every page load. `src/main.tsx` switches zod to
 * jitless mode before the app modules are imported.
 *
 * These tests therefore run the real production build (`pnpm build`, served by
 * `vite preview`) under exactly the policy Vercel installs and fail on any
 * `securitypolicyviolation`. A joined room needs a Supabase backend, so the
 * lobby route entry (the `/r/<code>` deep link and its join path) runs against
 * the production bundle here; the joined room is covered against the deployment
 * by the live smoke suite (#20).
 */

interface Violation {
  blockedURI: string;
  violatedDirective: string;
  disposition: string;
  sourceFile: string;
  lineNumber: number;
}

declare global {
  interface Window {
    /** Violations recorded by the listener `watchProductionCsp` installs. */
    __cspViolations?: Violation[];
    /** Set by the inline script injected in the watcher guard test. */
    __inlineScriptRan?: boolean;
  }
}

/**
 * Watches the page from before its first script runs, and serves every response
 * under the production policy (`csp-policy.ts`). `addInitScript` is the only way
 * to catch a violation raised while the app bundle is still being evaluated; a
 * listener installed with `page.evaluate` would always come too late.
 */
async function watchProductionCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: Violation[] = [];
    window.__cspViolations = violations;
    window.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
        disposition: event.disposition,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
      });
    });
  });
  await routeWithProductionCsp(page);
}

test('the production build raises no CSP violation on Home', async ({
  page,
}) => {
  await watchProductionCsp(page);
  await openUnderProductionCsp(page, '/');
  // The shell and the home view render, so the app bundle really evaluated.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('home-view')).toBeVisible();
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
});

test('entering the lobby route raises no CSP violation', async ({ page }) => {
  await watchProductionCsp(page);
  await openUnderProductionCsp(page, '/r/GHQKLP');
  // `/r/<code>` is the lobby deep link: it runs the join path (transport
  // creation, clock sync, wire schemas) before a room can render.
  await expect(
    page.getByTestId('route-joining').or(page.getByTestId('route-join-view')),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/r/GHQKLP');
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
});

test('the watcher catches a violation the production policy blocks', async ({
  page,
}) => {
  await watchProductionCsp(page);
  await openUnderProductionCsp(page, '/');
  // Guard for the assertions above: the policy must stay strict, and the
  // `addInitScript` listener must report what it is meant to catch. Without this
  // test a silently absent listener would make the two tests above vacuous.
  expect(PRODUCTION_CSP).not.toContain("'unsafe-eval'");
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__inlineScriptRan = true;';
    document.head.appendChild(script);
  });
  const blocked = await page.evaluate(() =>
    (window.__cspViolations ?? []).map((violation) => violation.blockedURI),
  );
  expect(blocked).toEqual(['inline']);
  expect(await page.evaluate(() => window.__inlineScriptRan === true)).toBe(
    false,
  );
});

/**
 * Pixel-Filz fonts (#62): the woff2 files ship in `public/fonts/` and are
 * covered by `default-src 'self'` (no `font-src` in `vercel.json`). Loading
 * every face under the production policy proves both the 200 and the absence of
 * a CSP block, and the OFL texts must stay next to the binaries.
 */
const FONT_FILES = [
  'Jersey10-Regular.woff2',
  'Silkscreen-Regular.woff2',
  'Silkscreen-Bold.woff2',
];
const FONT_LICENSES = ['OFL-Jersey10.txt', 'OFL-Silkscreen.txt'];

test('the Pixel-Filz fonts load from /fonts/ under the production CSP', async ({
  page,
}) => {
  await watchProductionCsp(page);
  const statuses = new Map<string, number>();
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith('/fonts/')) {
      statuses.set(pathname.slice('/fonts/'.length), response.status());
    }
  });
  await openUnderProductionCsp(page, '/');
  await expect(page.getByTestId('home-view')).toBeVisible();
  // `font-display: swap` plus lazy loading: ask for each face explicitly.
  const loaded = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load("400 22px 'Jersey 10'"),
      document.fonts.load('400 16px Silkscreen'),
      document.fonts.load('700 16px Silkscreen'),
    ]);
    return Array.from(document.fonts)
      .filter((face) => face.status === 'loaded')
      .map((face) => `${face.family.replace(/["']/g, '')}:${face.weight}`)
      .sort();
  });
  expect(loaded).toEqual(
    ['Jersey 10:400', 'Silkscreen:400', 'Silkscreen:700'].sort(),
  );
  expect(Object.fromEntries(statuses)).toEqual(
    Object.fromEntries(FONT_FILES.map((file) => [file, 200])),
  );
  for (const license of FONT_LICENSES) {
    const response = await page.request.get(`/fonts/${license}`);
    expect(response.status(), license).toBe(200);
    expect(await response.text()).toContain('SIL OPEN FONT LICENSE');
  }
  expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
});
