import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

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

interface HeaderEntry {
  key: string;
  value: string;
}

interface HeaderBlock {
  source: string;
  headers: HeaderEntry[];
}

interface VercelConfig {
  headers: HeaderBlock[];
}

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

/** The policy from the committed `vercel.json`, so the test cannot drift from it. */
function cspFromVercelJson(): string {
  const config = JSON.parse(
    readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'),
  ) as VercelConfig;
  for (const block of config.headers) {
    for (const header of block.headers) {
      if (header.key === 'Content-Security-Policy') {
        return header.value;
      }
    }
  }
  throw new Error('vercel.json has no Content-Security-Policy header');
}

const CSP = cspFromVercelJson();

/**
 * Watches the page from before its first script runs, and makes every response
 * carry the production policy (`vite preview` serves the build without it).
 * `addInitScript` is the only way to catch a violation raised while the app
 * bundle is still being evaluated; a listener installed with `page.evaluate`
 * would always come too late.
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
  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': CSP },
    });
  });
}

/** Navigates and proves the response really carried the policy under test. */
async function openUnderProductionCsp(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response, `no document response for ${path}`).not.toBeNull();
  expect(await response!.headerValue('content-security-policy')).toBe(CSP);
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
  expect(CSP).not.toContain("'unsafe-eval'");
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
