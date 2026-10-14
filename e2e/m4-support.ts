import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
import type { YouTubeCall } from './youtube-fixture';

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

export interface AudibleCall {
  call: YouTubeCall;
  /** The call's server-time estimate on the shared timeline. */
  serverAt: number;
}

/**
 * Samples the page clock mapping once per read: `[timeOrigin, offset]`, so a
 * recorded call's absolute server time is `timeOrigin + call.at + offset`.
 *
 * Every call's `at` is a `performance.now()` reading (sub-millisecond), while
 * the session clock is a *constant* offset on `Date.now()` (1 ms granularity).
 * Reconstructing a call's server time from a single `session.now()` sample
 * therefore loses the fractional part of the wall clock and lands up to 1 ms
 * *early*; that used to report the controller's legitimate at-`startAt` unmute
 * as a pre-start leak. Anchoring on `performance.timeOrigin` keeps the exact
 * sub-millisecond wall time and removes the bias, so no tolerance is needed.
 */
async function readCallClock(page: Page): Promise<readonly [number, number]> {
  return page.evaluate(
    () =>
      [
        performance.timeOrigin,
        window.__banger!.session.now() - Date.now(),
      ] as const,
  );
}

/**
 * Reads the recorded low-level calls for a video and classifies the `play`/`seek`
 * calls as audible (made while the player was unmuted). The call log is shared
 * with the submission *preview* player, so the walk only starts at the clip cue
 * (`playback.ts` is the only caller of `cueVideoById`); everything before it
 * belongs to the preview.
 *
 * `playback.ts` mutes the player for its preroll prebuffer, so the muted
 * pre-start `play` and the rewind `seekTo` are silent, while the real start (and
 * any drift correction) is audible. Each call's server time is reconstructed
 * in-page from `performance.now()` and the session clock, so it can be compared
 * to the absolute `startAt` without cross-clock assumptions.
 */
export async function audibleCalls(
  page: Page,
  videoId: string,
  type: 'play' | 'seek',
): Promise<AudibleCall[]> {
  const [origin, offset] = await readCallClock(page);
  return page.evaluate(
    ([id, kind, origin, offset]) => {
      const calls: YouTubeCall[] = window.__bangerYtCalls ?? [];
      let muted = false;
      let inPlayback = false;
      const audible: { call: YouTubeCall; serverAt: number }[] = [];
      for (const call of calls) {
        if (call.type === 'mute') {
          muted = true;
        } else if (call.type === 'unmute') {
          muted = false;
        } else if (call.type === 'cue' && call.videoId === id) {
          inPlayback = true;
        } else if (
          inPlayback &&
          call.type === kind &&
          call.videoId === id &&
          !muted
        ) {
          audible.push({ call, serverAt: origin + call.at + offset });
        }
      }
      return audible;
    },
    [videoId, type, origin, offset] as const,
  );
}

export interface PreStartLeak {
  call: YouTubeCall;
  /** The call's server-time estimate on the shared timeline. */
  serverAt: number;
}

/**
 * Detects a pre-start audio leak: an `unmute`, or a nonzero `volume`, applied
 * while the media is *playing* before `startAt`. The controller must keep the
 * player silent until the agreed start, even across a clip change while a muted
 * prebuffer is still in flight (where unmuting before the replacement cue would
 * make the old clip audible). Unlike `audibleCalls` this walks the raw
 * playing/mute state, so an "unmute while already playing" leak cannot hide
 * behind the mute/unmute bookkeeping.
 *
 * The call's server time is reconstructed exactly (see {@link readCallClock}):
 * the controller only restores audio once its own `Date.now()`-based clock
 * reaches `startAt`, so a legitimate unmute maps to `serverAt >= startAt` and
 * only a genuine pre-start leak falls below it.
 */
export async function preStartAudioLeaks(
  page: Page,
  startAt: number,
): Promise<PreStartLeak[]> {
  const [origin, offset] = await readCallClock(page);
  return page.evaluate(
    ([plannedStart, origin, offset]) => {
      const calls: YouTubeCall[] = window.__bangerYtCalls ?? [];
      let playing = false;
      // `playback.ts` is the only caller of `cueVideoById`, so the first cue
      // marks the long-lived playback player. Everything before it belongs to
      // the transient submission preview and must not taint the walk.
      let started = false;
      const leaks: { call: YouTubeCall; serverAt: number }[] = [];
      for (const call of calls) {
        if (!started) {
          started = call.type === 'cue';
          continue;
        }
        if (call.type === 'state') {
          playing = call.state === 1;
        } else if (call.type === 'pause' || call.type === 'cue') {
          playing = false;
        }
        const at = origin + call.at + offset;
        if (at >= plannedStart || !playing) {
          continue;
        }
        if (
          call.type === 'unmute' ||
          (call.type === 'volume' && (call.value ?? 0) > 0)
        ) {
          leaks.push({ call, serverAt: at });
        }
      }
      return leaks;
    },
    [startAt, origin, offset] as const,
  );
}
