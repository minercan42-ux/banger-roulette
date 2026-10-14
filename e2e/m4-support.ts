import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
import { youTubeCalls, type YouTubeCall } from './youtube-fixture';

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
  /** The call's session-clock time, read at the call (the app's own timeline). */
  serverAt: number;
}

/**
 * Classifies the recorded `play`/`seek` calls of a video as audible (made while
 * the player was unmuted). The call log is shared with the submission *preview*
 * player, so the walk only starts at the clip cue (`playback.ts` is the only
 * caller of `cueVideoById`); everything before it belongs to the preview.
 *
 * `playback.ts` mutes the player for its preroll prebuffer, so the muted
 * pre-start `play` and the rewind `seekTo` are silent, while the real start (and
 * any drift correction) is audible. Every call carries the session-clock time
 * the fixture read *at the call* (`YouTubeCall.serverAt`) — the same clock the
 * app uses — so it is comparable to the absolute `startAt` directly, with no
 * cross-clock reconstruction.
 *
 * Calls logged before the session exists (`serverAt === null`) are ignored; no
 * player call can predate the session.
 */
export function classifyAudibleCalls(
  calls: readonly YouTubeCall[],
  videoId: string,
  type: 'play' | 'seek',
): AudibleCall[] {
  let muted = false;
  let inPlayback = false;
  const audible: AudibleCall[] = [];
  for (const call of calls) {
    if (call.type === 'mute') {
      muted = true;
    } else if (call.type === 'unmute') {
      muted = false;
    } else if (call.type === 'cue' && call.videoId === videoId) {
      inPlayback = true;
    } else if (
      inPlayback &&
      call.type === type &&
      call.videoId === videoId &&
      !muted &&
      call.serverAt !== null
    ) {
      audible.push({ call, serverAt: call.serverAt });
    }
  }
  return audible;
}

/**
 * Reads the recorded low-level calls for a video and returns its audible ones.
 * See {@link classifyAudibleCalls} for the classification rules.
 */
export async function audibleCalls(
  page: Page,
  videoId: string,
  type: 'play' | 'seek',
): Promise<AudibleCall[]> {
  return classifyAudibleCalls(await youTubeCalls(page), videoId, type);
}

export interface PreStartLeak {
  call: YouTubeCall;
  /** The call's session-clock time, read at the call (the app's own timeline). */
  serverAt: number;
}

/**
 * Finds pre-start audio leaks: an `unmute`, or a nonzero `volume`, applied while
 * the media is *playing* before `startAt`. The player must stay silent until the
 * agreed start, even across a clip change while a muted prebuffer is still in
 * flight (unmuting before the replacement cue would make the old clip audible).
 * Unlike {@link classifyAudibleCalls} this walks the raw playing/mute state, so
 * an "unmute while already playing" leak cannot hide behind the mute/unmute
 * bookkeeping.
 *
 * Every call is dated with the session-clock value the fixture recorded *at the
 * call* (`YouTubeCall.serverAt`) — the same clock `playback.ts` compares against
 * `startAt` — and the comparison is direct, so no timestamp is reconstructed
 * from `Date.now`/`performance.now`. The normal audible-start paths
 * (`attemptStart`, `handlePlaying`) restore audio only once that clock reaches
 * `startAt`, so a legitimate start maps to `serverAt >= startAt` and only a
 * genuine pre-start leak falls below it. The *un*gated restorations
 * (`handleAutoplayBlocked` -> `abandonPrebuffer`, and the plan-less pre-warm
 * `applyAudio`) happen while the media is not playing, so this playing-state
 * walk already excludes them.
 *
 * Calls logged before the session exists (`serverAt === null`) are ignored; no
 * player call can predate the session.
 */
export function detectPreStartLeaks(
  calls: readonly YouTubeCall[],
  startAt: number,
): PreStartLeak[] {
  let playing = false;
  // `playback.ts` is the only caller of `cueVideoById`, so the first cue marks
  // the long-lived playback player. Everything before it belongs to the
  // transient submission preview and must not taint the walk.
  let started = false;
  const leaks: PreStartLeak[] = [];
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
    if (!playing || call.serverAt === null || call.serverAt >= startAt) {
      continue;
    }
    if (
      call.type === 'unmute' ||
      (call.type === 'volume' && (call.value ?? 0) > 0)
    ) {
      leaks.push({ call, serverAt: call.serverAt });
    }
  }
  return leaks;
}

/**
 * Reads the page's recorded calls and returns the pre-start audio leaks. See
 * {@link detectPreStartLeaks} for the detection rules.
 */
export async function preStartAudioLeaks(
  page: Page,
  startAt: number,
): Promise<PreStartLeak[]> {
  return detectPreStartLeaks(await youTubeCalls(page), startAt);
}
