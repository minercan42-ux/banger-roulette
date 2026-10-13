import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';

/**
 * M4 playback helpers. They drive the real UI/session and only read the
 * `?debug=1` overlay plus the external-boundary call log; nothing here reaches
 * into application internals.
 */

export interface PlaybackTiming {
  index: number;
  startAt: number;
  deadlineAt: number;
}

/** Reads the PLAYBACK phase timing or fails loudly outside the phase. */
export function playbackTiming(state: GameState | null): PlaybackTiming {
  if (!state || state.phase.type !== 'PLAYBACK') {
    throw new Error('Expected the session to be in the PLAYBACK phase');
  }
  return {
    index: state.phase.index,
    startAt: state.phase.startAt,
    deadlineAt: state.phase.deadlineAt,
  };
}

/**
 * Adds `?debug=1` to the current address before the playback view mounts. The
 * harness rewrites the served file, not the browser URL, so the overlay sees
 * the flag. The popstate re-render makes the change visible immediately.
 */
export async function enablePlaybackDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('debug', '1');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/** Checks the per-tab playback consent if the tab has not consented already. */
export async function consentToPlayback(page: Page): Promise<void> {
  const consent = page.getByTestId('playback-consent');
  if ((await consent.count()) === 0) {
    return;
  }
  if (!(await consent.isChecked())) {
    await consent.check();
  }
}

export interface PlaybackDiagnostics {
  status: string | null;
  offsetMs: number | null;
  rttMs: number | null;
  synchronized: boolean | null;
  plannedStart: number | null;
  plannedDeadline: number | null;
  observedStart: number | null;
  startSkewMs: number | null;
  driftMs: number | null;
}

function asNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads the normalized diagnostics the controller published to the overlay. */
export async function readDiagnostics(
  page: Page,
): Promise<PlaybackDiagnostics> {
  const debug = page.getByTestId('playback-debug');
  await expect(debug).toBeVisible({ timeout: 20000 });
  const data = await debug.evaluate(
    (element) => Object.assign({}, element.dataset) as Record<string, string>,
  );
  const synchronized =
    data.synchronized === undefined ? null : data.synchronized === 'true';
  return {
    status: data.status ?? null,
    offsetMs: asNumber(data.offsetMs),
    rttMs: asNumber(data.rttMs),
    synchronized,
    plannedStart: asNumber(data.plannedStart),
    plannedDeadline: asNumber(data.plannedDeadline),
    observedStart: asNumber(data.observedStart),
    startSkewMs: asNumber(data.startSkewMs),
    driftMs: asNumber(data.driftMs),
  };
}

export interface PlaybackStatusView {
  state: string | null;
  errorCode: number | null;
}

export async function playbackStatus(page: Page): Promise<PlaybackStatusView> {
  const status = page.getByTestId('playback-status');
  return {
    state: await status.getAttribute('data-state'),
    errorCode: asNumber(
      (await status.getAttribute('data-error-code')) ?? undefined,
    ),
  };
}

/** Waits until the playback view has reached a given engine song index. */
export async function waitForPlaybackIndex(
  page: Page,
  index: number,
  timeoutMs = 30000,
): Promise<void> {
  await expect(page.getByTestId('playback-phase')).toHaveAttribute(
    'data-index',
    String(index),
    { timeout: timeoutMs },
  );
}

/** Waits until the controller reports a concrete playback state. */
export async function waitForPlaybackState(
  page: Page,
  state: string,
  timeoutMs = 30000,
): Promise<void> {
  await expect(page.getByTestId('playback-status')).toHaveAttribute(
    'data-state',
    state,
    { timeout: timeoutMs },
  );
}
