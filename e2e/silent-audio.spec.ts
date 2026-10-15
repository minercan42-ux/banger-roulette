import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { closeStages, harnessContext, newStage } from './m3-support';
import { NO_AUDIO_DEVICE } from './silent-audio';

/**
 * FR-07: the consent click awaits `AudioContext.resume()`, and the harness sink
 * may only stand in for the one answer an engine cannot give (see
 * `silent-audio.ts`). These cases pin that boundary down behaviourally, with the
 * mode flag on and off on the same engine, so no case depends on the audio
 * hardware of the runner: a native success, a native rejection and a later
 * `suspend()`/`close()` all have to survive the fallback and its grace timer.
 *
 * The lifecycles are read *after* the grace window, because that is when the
 * latching sink used to claim a context it had never unlocked.
 */

/** How the page's `AudioContext.prototype.resume` behaves in the case. */
type ResumeShape = 'native' | 'pending' | 'reject' | 'settle';

/** Well past the sink's grace window, so an unsolicited fallback would show. */
const AFTER_GRACE_MS = 900;

interface Harness {
  page: Page;
  close: () => Promise<void>;
}

interface Observation {
  /** The `resume()` outcome: `resolved`, `rejected: …` or `pending`. */
  outcome: string;
  elapsed: number;
  /** State of that context right after the resume attempt. */
  resumed: string;
  /** The same context after `suspend()`, read past the grace window. */
  suspended: string;
  /** A second context after `close()`, read past the grace window. */
  closed: string;
}

/**
 * Loads the harness with the sink mode and a scripted `resume()`. The patch runs
 * before any page script, so the sink wraps the scripted answer exactly like it
 * wraps the answer of the engine this mode stands in for.
 */
async function loadHarness(
  browser: Browser,
  shape: ResumeShape,
  mode?: string,
): Promise<Harness> {
  // Opened directly instead of through `harnessContext`: these cases choose the
  // mode themselves, including the ones that must run without it.
  const context = await browser.newContext();
  await context.addInitScript(
    (config) => {
      if (config.mode !== undefined) {
        window.__silentAudioMode = config.mode;
      }
      if (config.shape === 'native') {
        return;
      }
      AudioContext.prototype.resume = function (): Promise<void> {
        if (config.shape === 'settle') {
          return Promise.resolve();
        }
        if (config.shape === 'reject') {
          return Promise.reject(new Error('no audio device'));
        }
        // The pending answer of an engine that cannot start its sink.
        return Promise.withResolvers<void>().promise;
      };
    },
    { shape, mode },
  );
  const page = await context.newPage();
  await page.goto('/');
  // The harness entry installs the sink, so wait until it has run.
  await page.waitForFunction(() => window.__banger !== undefined);
  return { close: () => context.close(), page };
}

/**
 * Resumes one context, drives it through `suspend()` and a second one through
 * `close()`, and reads all three states after the grace window. `racePending`
 * reports a `resume()` that never settles instead of waiting for it forever.
 */
async function observe(page: Page, racePending: boolean): Promise<Observation> {
  return page.evaluate(
    async (config) => {
      const { promise: pastGrace, resolve } = Promise.withResolvers<void>();
      window.setTimeout(resolve, config.waitMs);
      const resumed = new AudioContext();
      const started = performance.now();
      const attempt = resumed.resume().then(
        () => 'resolved',
        (error: unknown) => `rejected: ${(error as Error).message}`,
      );
      const outcome = config.racePending
        ? await Promise.race([attempt, pastGrace.then(() => 'pending')])
        : await attempt;
      const elapsed = performance.now() - started;
      const justResumed = resumed.state;
      await resumed.suspend();
      const closed = new AudioContext();
      void closed.resume().catch(() => undefined);
      await closed.close();
      await pastGrace;
      return {
        outcome,
        elapsed,
        resumed: justResumed,
        suspended: resumed.state,
        closed: closed.state,
      };
    },
    { racePending, waitMs: AFTER_GRACE_MS },
  );
}

test('native: a pending resume stays pending and the context stays native', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'pending');
  try {
    const result = await observe(harness.page, true);
    expect(result.outcome).toBe('pending');
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('native: a rejected resume rejects and the context stays native', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'reject');
  try {
    const result = await observe(harness.page, false);
    expect(result.outcome).toBe('rejected: no audio device');
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('native: a settled resume keeps the native lifecycle of the context', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'settle');
  try {
    const result = await observe(harness.page, false);
    expect(result.outcome).toBe('resolved');
    // Nothing may hold the answer back in an engine that has none to give.
    expect(result.elapsed).toBeLessThan(450);
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('selected: a pending resume reports running, and its lifecycle still wins', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'pending', NO_AUDIO_DEVICE);
  try {
    const result = await observe(harness.page, true);
    expect(result.outcome).toBe('resolved');
    expect(result.resumed).toBe('running');
    expect(result.elapsed).toBeGreaterThanOrEqual(450);
    expect(result.elapsed).toBeLessThan(2000);
    // The native answers the fallback stood in for; the un-cancelled timer used
    // to keep reporting `running` here.
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('selected: a native settle does not activate the fallback', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'settle', NO_AUDIO_DEVICE);
  try {
    const result = await observe(harness.page, false);
    expect(result.outcome).toBe('resolved');
    expect(result.elapsed).toBeLessThan(450);
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('selected: a native rejection does not activate the fallback', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'reject', NO_AUDIO_DEVICE);
  try {
    const result = await observe(harness.page, false);
    expect(result.outcome).toBe('rejected: no audio device');
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('selected: the real resume of this engine ends running', async ({
  browser,
}) => {
  const harness = await loadHarness(browser, 'native', NO_AUDIO_DEVICE);
  try {
    const result = await observe(harness.page, false);
    expect(result.outcome).toBe('resolved');
    expect(result.resumed).toBe('running');
    expect(result.elapsed).toBeLessThan(3000);
    expect(result.suspended).toBe('suspended');
    expect(result.closed).toBe('closed');
  } finally {
    await harness.close();
  }
});

test('the harness factories select the no-device sink for Firefox only', async ({
  browser,
  browserName,
}) => {
  const expected = browserName === 'firefox' ? NO_AUDIO_DEVICE : null;
  const stage = await newStage(browser, { nickname: 'Ada' });
  // Contexts a spec opens itself come from `harnessContext`; both roads have to
  // carry the mode, because the FR-07 consent click is not rarer in one of them.
  const context = await harnessContext(browser, { locale: 'en-US' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForFunction(() => window.__banger !== undefined);
    const readMode = (target: Page) =>
      target.evaluate(() => window.__silentAudioMode ?? null);
    expect(await readMode(stage.page)).toBe(expected);
    expect(await readMode(page)).toBe(expected);
  } finally {
    await closeStages([stage]);
    await context.close();
  }
});
