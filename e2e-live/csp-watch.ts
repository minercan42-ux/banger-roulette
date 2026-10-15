import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * The CSP and error collector of the live smoke (M7 / issue #20), in one place.
 *
 * `e2e-live/smoke.spec.ts` runs it against the deployment and is deliberately
 * **not** part of PR CI. `e2e/csp/live-csp-collector.spec.ts` runs the very same
 * collector and the very same `assertClean` offline: once on the production
 * build under the exact `vercel.json` policy, and once against a same-origin
 * external script that performs a caught, non-empty `eval`. Because both specs
 * import this module, an exemption reintroduced inside `assertClean` (the
 * mistake issue #20's review caught) makes the offline regression fail in PR
 * CI instead of silently weakening the smoke:
 *
 * - `pnpm test:e2e:live` (deployment, green path)
 * - `pnpm test:e2e` (offline: clean path **and** a real `blockedURI: "eval"`)
 */

/** Console marker the in-page CSP listener reports violations with. */
export const CSP_PREFIX = 'banger-csp-violation ';

export interface CspViolation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}

export interface WatchedPage {
  label: string;
  /** Console errors that originate from the app origin or carry no location. */
  consoleErrors: string[];
  /**
   * Uncaught page errors. A blocked `eval` that a library (or a probe) swallows
   * with `try`/`catch` must not appear here; it is a CSP violation instead.
   */
  pageErrors: string[];
  /** CSP violations as rendered strings: any one of these fails the smoke. */
  csp: string[];
  /** The parsed CSP violations, so a caller can assert on `blockedURI`. */
  violations: CspViolation[];
}

/** Runtime check of the JSON the in-page CSP listener reports. */
export function parseCspViolation(text: string): CspViolation | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') {
      return null;
    }
    return {
      directive:
        'directive' in value && typeof value.directive === 'string'
          ? value.directive
          : '',
      blockedURI:
        'blockedURI' in value && typeof value.blockedURI === 'string'
          ? value.blockedURI
          : '',
      sourceFile:
        'sourceFile' in value && typeof value.sourceFile === 'string'
          ? value.sourceFile
          : '',
      lineNumber:
        'lineNumber' in value && typeof value.lineNumber === 'number'
          ? value.lineNumber
          : 0,
      sample:
        'sample' in value && typeof value.sample === 'string'
          ? value.sample
          : '',
    };
  } catch {
    return null;
  }
}

/**
 * Installs the in-page violation reporter on a context, before any of its pages
 * load, so a violation raised while the app bundle is still evaluating is
 * caught. The listener reports through `console.warn` instead of a `window`
 * array, because reading such an array would need `page.evaluate`, whose
 * Playwright-internal `eval` is itself blocked by the deployment's strict
 * `script-src` and would show up as a fake app violation.
 */
export async function installViolationReporter(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    window.addEventListener('securitypolicyviolation', (event) => {
      console.warn(
        'banger-csp-violation ' +
          JSON.stringify({
            directive: event.effectiveDirective,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            sample: event.sample,
          }),
      );
    });
  });
}

/**
 * Attaches the console and page-error collectors to a page. Only console errors
 * that originate from the app origin count: YouTube iframe chatter from
 * `youtube-nocookie.com` is not application noise and must not fail a smoke.
 */
export function watchPage(
  page: Page,
  label: string,
  origin: string,
): WatchedPage {
  const watched: WatchedPage = {
    label,
    consoleErrors: [],
    pageErrors: [],
    csp: [],
    violations: [],
  };
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(CSP_PREFIX)) {
      const violation = parseCspViolation(text.slice(CSP_PREFIX.length));
      if (violation === null) {
        watched.csp.push(`[${label}] unparseable report: ${text}`);
      } else {
        watched.violations.push(violation);
        watched.csp.push(`[${label}] ${JSON.stringify(violation)}`);
      }
      return;
    }
    if (message.type() !== 'error') {
      return;
    }
    const url = message.location().url;
    if (url === '' || url.startsWith(origin)) {
      watched.consoleErrors.push(`[${label}] console: ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    watched.pageErrors.push(`[${label}] pageerror: ${error.message}`);
  });
  return watched;
}

/**
 * Fails the test on any CSP violation, application console error or uncaught
 * page error. There is no exemption: the deployment's `script-src` has no
 * `'unsafe-eval'` and no `'report-sample'`, so an empty `sample` cannot
 * distinguish zod's `allowsEval()` probe from a real application `eval` - issue
 * #43 removes that probe at the source instead.
 *
 * The offline regression `e2e/csp/live-csp-collector.spec.ts` runs this exact
 * function against a caught, non-empty `eval` and requires it to fail, so an
 * exemption reintroduced here breaks PR CI. That probe produces the CSP report
 * only: no uncaught page error and no forwarded console error (measured with
 * the exemption temporarily restored - `assertClean` then threw nothing).
 */
export function assertClean(pages: readonly WatchedPage[]): void {
  const consoleErrors = pages.flatMap((page) => page.consoleErrors);
  const pageErrors = pages.flatMap((page) => page.pageErrors);
  const csp = pages.flatMap((page) => page.csp);
  expect(consoleErrors, 'application console errors').toEqual([]);
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(csp, 'Content-Security-Policy violations').toEqual([]);
}
