import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assertClean,
  installViolationReporter,
  watchPage,
} from '../../e2e-live/csp-watch';
import {
  openUnderProductionCsp,
  PRODUCTION_CSP,
  routeWithProductionCsp,
} from './csp-policy';

/**
 * Offline regression for the live smoke's CSP guard (issue #20 review finding):
 * `e2e-live/smoke.spec.ts` never runs in PR CI, so its collector and its clean
 * assertion are exercised here, against the real production build under the
 * exact `vercel.json` policy.
 *
 * The second test is the guard for the guard. It serves a same-origin external
 * script that performs a caught, non-empty `eval` - the shape of the case the
 * removed `csp-eval-probe-exempt` exemption used to wave through - and requires
 * the collector to report `blockedURI: "eval"` and `assertClean` to fail on it.
 * Reintroducing that exemption now fails this spec in PR CI. `e2e/csp/production-csp.spec.ts`
 * cannot cover this: it watches a `window.__cspViolations` array and an inline
 * script, not the console-forwarding collector or a caught `eval`, so it would
 * keep passing with the exemption restored.
 *
 * Runs with `pnpm test:e2e` (`playwright.csp.config.ts`, `vite preview` of
 * `pnpm build`). The production smoke stays outside PR CI.
 */

/** `playwright.csp.config.ts` `use.baseURL`; cross-checked after every load. */
const BASE_URL = 'http://127.0.0.1:4174';
const ORIGIN = new URL(BASE_URL).origin;

/** Path of the routed fixture; never written to disk, never hits the server. */
const PROBE_PATH = '/csp-eval-probe.js';

/**
 * The probe body. It is a non-empty `new Function` (an empty one would be
 * reported with the same, empty `sample` on this policy) whose failure is
 * swallowed, so only the CSP report - never an uncaught page error - may
 * surface. It is an external file rather than a `page.evaluate` callback,
 * because that callback would itself need the `eval` under test.
 */
const PROBE_SOURCE = [
  'try {',
  "  new Function('return 1')();",
  '} catch {',
  '  // A library probing for eval support swallows the refusal.',
  '}',
].join('\n');

/**
 * Opens `/` under the production policy and proves the page really came from
 * the port this spec filters console errors by (`watchPage`'s `origin`).
 */
async function openApp(page: Page): Promise<void> {
  await openUnderProductionCsp(page, '/');
  expect(
    new URL(page.url()).origin,
    'playwright.csp.config.ts baseURL drifted from this spec',
  ).toBe(ORIGIN);
  // The shell and the home view render, so the app bundle really evaluated.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('home-view')).toBeVisible();
}

test('the live collector stays clean on the production build under the exact policy', async ({
  context,
  page,
}) => {
  const watcher = watchPage(page, 'home', ORIGIN);
  await installViolationReporter(context);
  await routeWithProductionCsp(page);
  await openApp(page);
  // The same collector and the same assertion the deployment smoke runs, on a
  // page whose only script source is the committed policy: it must be silent.
  assertClean([watcher]);
});

test('the live collector reports a caught non-empty eval and fails its clean assertion', async ({
  context,
  page,
}) => {
  const watcher = watchPage(page, 'probe', ORIGIN);
  await installViolationReporter(context);
  // Appending the probe once the document exists (deferred module scripts are
  // done by then) keeps the app's own load out of the measurement.
  await page.addInitScript((probePath: string) => {
    const inject = () => {
      const script = document.createElement('script');
      script.src = probePath;
      document.head.append(script);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
      inject();
    }
  }, PROBE_PATH);
  await routeWithProductionCsp(page, [
    { path: PROBE_PATH, body: PROBE_SOURCE },
  ]);
  await openApp(page);

  // The policy has no `report-sample`, so an exemption keyed on an empty
  // `sample` cannot tell this probe from a real application `eval`.
  expect(PRODUCTION_CSP).not.toContain('report-sample');
  await expect
    .poll(
      () =>
        watcher.violations.some((violation) => violation.blockedURI === 'eval'),
      { timeout: 15_000 },
    )
    .toBe(true);
  const evalViolation = watcher.violations.find(
    (violation) => violation.blockedURI === 'eval',
  );
  expect(evalViolation?.directive, 'eval is blocked by script-src').toContain(
    'script-src',
  );
  // `try`/`catch` swallowed the refusal: the guard must fail on the CSP report
  // alone, never on an uncaught page error.
  expect(watcher.pageErrors, 'the probe must not throw uncaught').toEqual([]);
  expect(() => assertClean([watcher])).toThrow(
    /Content-Security-Policy violations/,
  );
});
