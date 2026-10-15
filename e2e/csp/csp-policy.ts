import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The production Content-Security-Policy of the deployment and the harness that
 * serves the real build under it, shared by the `e2e/csp` specs so neither can
 * drift from the other or from `vercel.json`.
 *
 * `playwright.csp.config.ts` serves `pnpm build` with `vite preview`, which
 * sends no CSP header of its own: the header has to be added to every response
 * by routing, for the document and its subresources alike.
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

/** The policy from the committed `vercel.json`, so no test can drift from it. */
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

export const PRODUCTION_CSP = cspFromVercelJson();

export interface RoutedScript {
  /** Path (on the `vite preview` origin) the script answers for. */
  path: string;
  /** JavaScript body, served `text/javascript`, same-origin by construction. */
  body: string;
}

/**
 * Makes every response carry the production policy and answers `scripts` from
 * this process instead of the preview server. A single route handler serves
 * both purposes on purpose: two overlapping `page.route` handlers would make
 * the outcome depend on Playwright's registration order.
 */
export async function routeWithProductionCsp(
  page: Page,
  scripts: readonly RoutedScript[] = [],
): Promise<void> {
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const script = scripts.find((entry) => entry.path === path);
    if (script) {
      await route.fulfill({
        contentType: 'text/javascript; charset=utf-8',
        headers: { 'content-security-policy': PRODUCTION_CSP },
        body: script.body,
      });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': PRODUCTION_CSP,
      },
    });
  });
}

/** Navigates and proves the response really carried the policy under test. */
export async function openUnderProductionCsp(
  page: Page,
  path: string,
): Promise<void> {
  const response = await page.goto(path);
  expect(response, `no document response for ${path}`).not.toBeNull();
  expect(await response!.headerValue('content-security-policy')).toBe(
    PRODUCTION_CSP,
  );
}
