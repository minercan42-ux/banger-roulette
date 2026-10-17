import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
import {
  assembleRoom,
  closeStages,
  ensureConsent,
  enterSubmission,
  harnessContext,
  joinRoom,
  newStage,
  setSettings,
  snapshot,
  stateOf,
  submitSongViaUi,
  unlockSound,
  waitForPhase,
  type Stage,
} from './m3-support';
import {
  audibleCalls,
  classifyAudibleCalls,
  detectPreStartLeaks,
  enablePlaybackDebug,
  playbackStateWithClock,
  playbackStatus,
  playbackTiming,
  preStartAudioLeaks,
  readDiagnostics,
  waitForPlaybackIndex,
  waitForPlaybackState,
  type AudibleCall,
  type PreStartLeak,
} from './m4-support';
import {
  failIframeApi,
  installYouTubeFixture,
  setFixtureVideo,
  watchYouTubeRequests,
  youTubeCalls,
  type YouTubeCall,
  type YouTubeFixtureMap,
} from './youtube-fixture';

/**
 * M4 consumer coverage: synchronized multi-client playback (FR-30..FR-35,
 * AK-7). Every scenario drives the real UI, the real `GameSession`, the real
 * engine and the real `src/player` lifecycle; only the external YouTube edge is
 * replaced by `youtube-fixture.ts`. The fixture's playback clock advances on
 * `performance.now()`, so a page whose wall clock is skewed (FR-31) still
 * reports media time honestly.
 *
 * Distinct 11-char ids so `parseYouTubeLink` accepts them and every `Media`
 * passes the shared schemas.
 */
const SONG_A = 'dQw4w9WgXcQ';
const SONG_B = 'kJQP7kiw5Fk';
const SONG_C = '3JZ_D3ELwOQ';
const SONG_D = 'fJ9rUzIMcZQ';

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Reads the engine's playback order, failing when the round is not playing. */
function playbackOrder(state: GameState | null): string[] {
  const order = state?.round?.playbackOrder ?? [];
  expect(order.length).toBeGreaterThan(0);
  return order;
}

/** Maps each song's video id to its owner ids for the flag-gate assertions. */
function ownerIndex(state: GameState | null): Map<string, readonly string[]> {
  const entries = state?.round?.songs ?? [];
  return new Map(entries.map((song) => [song.media.videoId, song.ownerIds]));
}

async function submissionCount(page: Page): Promise<number> {
  return Object.keys((await stateOf(page))?.round?.submissions ?? {}).length;
}

/** Submits one distinct song per stage and waits until all are recorded. */
async function submitAll(
  stages: readonly Stage[],
  videoIds: readonly string[],
): Promise<void> {
  for (let index = 0; index < stages.length; index += 1) {
    await submitSongViaUi(stages[index]!.page, watchUrl(videoIds[index]!));
  }
  await expect
    .poll(() => submissionCount(stages[0]!.page), { timeout: 20000 })
    .toBe(stages.length);
}

/** Clicks finish on the given stages, then lands every client on PLAYBACK. */
async function finishToPlayback(stages: readonly Stage[]): Promise<void> {
  for (const stage of stages) {
    await stage.page.getByTestId('finish-submission').click();
  }
  await waitForPhase(stages[0]!.page, 'PLAYBACK', 30000);
  await Promise.all(
    stages.map((stage) => waitForPhase(stage.page, 'PLAYBACK', 30000)),
  );
}

function trackPageErrors(pages: readonly Page[]): string[] {
  const errors: string[] = [];
  for (const page of pages) {
    page.on('pageerror', (error) => errors.push(error.message));
  }
  return errors;
}

test('four clients share one song order and start within ±500 ms across skewed clocks', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const skews = [7_000, -3_000, 61_000, -250];
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', wallClockOffsetMs: skews[0] }),
    newStage(browser, { nickname: 'Bruno', wallClockOffsetMs: skews[1] }),
    newStage(browser, { nickname: 'Cleo', wallClockOffsetMs: skews[2] }),
    newStage(browser, { nickname: 'Dario', wallClockOffsetMs: skews[3] }),
  ]);
  try {
    const errors = trackPageErrors(stages.map((stage) => stage.page));
    await assembleRoom(stages[0], stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C, SONG_D]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    // FR-30: identical, RNG-derived order on every client.
    const orders = await Promise.all(
      stages.map(async (stage) => playbackOrder(await stateOf(stage.page))),
    );
    for (const order of orders.slice(1)) {
      expect(order).toEqual(orders[0]);
    }

    // FR-31: one absolute server `startAt`, independent of the wall clock.
    const timing = playbackTiming(await stateOf(stages[0]!.page));
    const firstVideoId = orders[0]![0]!;
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const localTiming = playbackTiming(await stateOf(stage.page));
      expect(localTiming.startAt).toBe(timing.startAt);
      // AK-7: the preroll stays silent. Any audible (unmuted) start of the first
      // song must sit at or after the agreed start; the recorded
      // mute/unmute/volume/play order proves the preroll play was muted.
      const audible = await audibleCalls(stage.page, firstVideoId, 'play');
      for (const { serverAt } of audible) {
        expect(serverAt).toBeGreaterThanOrEqual(timing.startAt - 200);
      }
      // And nothing may be unmuted (or raised above zero) while the media is
      // still playing before the agreed start.
      expect(await preStartAudioLeaks(stage.page, timing.startAt)).toEqual([]);
      // No playback before the agreed start, whenever the read lands early. The
      // state and the clock come from one evaluation: judging a state read after
      // the fixture inspections above against an older clock read would flag a
      // start that already happened.
      const before = await playbackStateWithClock(stage.page);
      if (before.serverNow >= timing.startAt - 100) {
        continue;
      }
      expect(before.state).not.toBe('playing');
    }

    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'playing', 20000)),
    );

    const observed: number[] = [];
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const diagnostics = await readDiagnostics(stage.page);
      expect(diagnostics.status).toBe('playing');
      // Clock sync really compensated the injected skew.
      expect(diagnostics.synchronized).toBe(true);
      expect(diagnostics.offsetMs).not.toBeNull();
      expect(
        Math.abs((diagnostics.offsetMs ?? 0) + skews[index]!),
      ).toBeLessThanOrEqual(100);
      // The first *actual* PLAYING event, never a method call, bounds the start.
      expect(diagnostics.observedStart).not.toBeNull();
      expect(diagnostics.observedStart ?? 0).toBeGreaterThanOrEqual(
        timing.startAt,
      );
      expect(diagnostics.startSkewMs).not.toBeNull();
      expect(Math.abs(diagnostics.startSkewMs ?? 0)).toBeLessThanOrEqual(500);
      observed.push(diagnostics.observedStart ?? 0);
    }
    // AK-7: the whole ensemble starts within a single ±500 ms window.
    expect(Math.max(...observed) - Math.min(...observed)).toBeLessThanOrEqual(
      500,
    );
    expect(errors).toEqual([]);
  } finally {
    await closeStages(stages);
  }
});

test('drift over 750 ms is corrected while a sub-threshold offset is left alone', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const drifting: YouTubeFixtureMap = {
    [SONG_A]: { startOffsetMs: 1_200 },
    [SONG_B]: { startOffsetMs: 1_200 },
    [SONG_C]: { startOffsetMs: 1_200 },
  };
  const slight: YouTubeFixtureMap = {
    [SONG_A]: { startOffsetMs: 250 },
    [SONG_B]: { startOffsetMs: 250 },
    [SONG_C]: { startOffsetMs: 250 },
  };
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', videos: drifting }),
    newStage(browser, { nickname: 'Bruno', videos: slight }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    await assembleRoom(stages[0], stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);
    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'playing', 20000)),
    );

    const order = playbackOrder(await stateOf(stages[0]!.page));
    const videoId = order[0]!;
    // Let the ~250 ms drift loop observe, seek and settle.
    await stages[0]!.page.waitForTimeout(2_000);

    // The muted pre-start warm-up rewinds silently; only audible (unmuted)
    // seeks are drift corrections. FR-32: only the >750 ms client seeks, and it
    // converges back under 750.
    const driftSeeks = async (stage: Stage) =>
      audibleCalls(stage.page, videoId, 'seek');
    expect((await driftSeeks(stages[0]!)).length).toBeGreaterThanOrEqual(1);
    expect((await driftSeeks(stages[1]!)).length).toBe(0);
    expect((await driftSeeks(stages[2]!)).length).toBe(0);

    for (const stage of stages) {
      const diagnostics = await readDiagnostics(stage.page);
      expect(diagnostics.status).toBe('playing');
      expect(Math.abs(diagnostics.driftMs ?? 0)).toBeLessThanOrEqual(750);
    }
  } finally {
    await closeStages(stages);
  }
});

test('the sync diagnostics stay hidden from players until the debug switch is on', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    await assembleRoom(stages[0], stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    await finishToPlayback(stages);
    const page = stages[0]!.page;
    await waitForPlaybackState(page, 'playing', 20000);

    // Without the switch: no table, no raw timestamps, no free-text status.
    const timing = playbackTiming(await stateOf(page));
    await expect(page.getByTestId('playback-phase')).toBeVisible();
    await expect(page.getByTestId('playback-debug')).toHaveCount(0);
    await expect(page.getByTestId('playback-status')).toHaveClass(/sr-only/);
    const text = await page.getByTestId('playback-phase').innerText();
    expect(text).not.toContain(String(Math.round(timing.startAt)));
    expect(text).not.toContain(String(Math.round(timing.deadlineAt)));
    // Volume, mute and the rating bar (with its genre-fail chip) stay available (volume and mute
    // live in the top bar since #107; the slider sits in its popover).
    await expect(page.getByTestId('playback-mute')).toBeVisible();
    await page.getByTestId('volume-toggle').click();
    await expect(page.getByTestId('playback-volume')).toBeVisible();
    await page.getByTestId('volume-toggle').click();
    await expect(page.getByTestId('rating-section')).toBeVisible();

    // localStorage `banger-roulette.debug` turns the table on.
    await page.evaluate(() => {
      window.localStorage.setItem('banger-roulette.debug', '1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByTestId('playback-debug')).toBeVisible();
    await expect(page.getByTestId('playback-status')).not.toHaveClass(
      /sr-only/,
    );
    expect((await readDiagnostics(page)).plannedStart).toBe(timing.startAt);
  } finally {
    await closeStages(stages);
  }
});

test('a late cue and heavy buffering catch up without blocking the round', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const lateCue: YouTubeFixtureMap = {
    [SONG_A]: { cueDelayMs: 4_000 },
    [SONG_B]: { cueDelayMs: 4_000 },
    [SONG_C]: { cueDelayMs: 4_000 },
  };
  const buffering: YouTubeFixtureMap = {
    [SONG_A]: { bufferingMs: 4_000 },
    [SONG_B]: { bufferingMs: 4_000 },
    [SONG_C]: { bufferingMs: 4_000 },
  };
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', videos: lateCue }),
    newStage(browser, { nickname: 'Bruno', videos: buffering }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    await assembleRoom(stages[0], stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    // FR-33: a delayed client still reaches PLAYING and catches up.
    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'playing', 25000)),
    );
    await stages[0]!.page.waitForTimeout(2_000);

    const order = playbackOrder(await stateOf(stages[0]!.page));
    const videoId = order[0]!;
    for (const stage of [stages[0]!, stages[1]!]) {
      // Both the late cue and the heavy buffering start the muted media only
      // after startAt, so each needs a real (audible) FR-32 correction; the
      // silent pre-start alignment seeks do not count.
      const seeks = await audibleCalls(stage.page, videoId, 'seek');
      expect(seeks.length).toBeGreaterThanOrEqual(1);
      const diagnostics = await readDiagnostics(stage.page);
      expect(diagnostics.status).toBe('playing');
      expect(Math.abs(diagnostics.driftMs ?? 0)).toBeLessThanOrEqual(750);
    }
  } finally {
    await closeStages(stages);
  }
});

test('a blocked autoplay needs a direct gesture while others keep playing', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    await assembleRoom(stages[0], stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    // Only the *playback* of Alice's browser blocks autoplay; her preview has
    // already been validated and destroyed, so this flips the playback edge.
    // A late cue keeps her from prebuffering (the muted pre-start play is
    // permitted), so the audible start is a cold, unmuted play that is blocked.
    for (const videoId of [SONG_A, SONG_B, SONG_C]) {
      await setFixtureVideo(stages[0]!.page, videoId, {
        autoplayBlocked: true,
        cueDelayMs: 4_000,
      });
    }
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    const alice = stages[0]!;
    await waitForPlaybackState(alice.page, 'blocked', 20000);
    await expect(alice.page.getByTestId('playback-recover')).toBeVisible();
    // Isolation: the other clients are unaffected by the local block.
    await Promise.all(
      stages
        .slice(1)
        .map((stage) => waitForPlaybackState(stage.page, 'playing', 20000)),
    );

    const order = playbackOrder(await stateOf(stages[0]!.page));
    const videoId = order[0]!;
    const beforeRecover = (await youTubeCalls(alice.page)).filter(
      (call) => call.type === 'play' && call.videoId === videoId,
    );
    expect(beforeRecover.length).toBeGreaterThanOrEqual(1);

    await alice.page.getByTestId('playback-recover').click();
    await waitForPlaybackState(alice.page, 'playing', 20000);
    const afterRecover = (await youTubeCalls(alice.page)).filter(
      (call) => call.type === 'play' && call.videoId === videoId,
    );
    // The gesture issues one more playVideo for the blocked clip.
    expect(afterRecover.length).toBeGreaterThan(beforeRecover.length);
    // The controller only trusts the real PLAYING event, never the gesture.
    const diagnostics = await readDiagnostics(alice.page);
    expect(diagnostics.status).toBe('playing');
    expect(diagnostics.observedStart).not.toBeNull();
  } finally {
    await closeStages(stages);
  }
});

test('a locally failing song is skipped while the host deadline continues', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    await assembleRoom(stages[0], stages.slice(1));
    await setSettings(stages[0]!.page, { clipSeconds: 15 });
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    const order = playbackOrder(await stateOf(stages[0]!.page));
    expect(order.length).toBeGreaterThanOrEqual(3);
    const failingId = order[1]!;
    // Cleo's boundary rejects the second song; everyone else plays it.
    await setFixtureVideo(stages[2]!.page, failingId, { error: 150 });

    await waitForPlaybackIndex(stages[2]!.page, 1, 40000);
    await expect(stages[2]!.page.getByTestId('playback-skipped')).toBeVisible({
      timeout: 20000,
    });
    await expect
      .poll(async () => (await playbackStatus(stages[2]!.page)).state, {
        timeout: 20000,
      })
      .toBe('skipped');

    // The round is not blocked: the others play and the host advances past it.
    await Promise.all(
      stages
        .slice(0, 2)
        .map((stage) => waitForPlaybackState(stage.page, 'playing', 40000)),
    );
    await waitForPlaybackIndex(stages[0]!.page, 2, 40000);
    await waitForPlaybackIndex(stages[2]!.page, 2, 40000);
    await waitForPlaybackState(stages[2]!.page, 'playing', 30000);
  } finally {
    await closeStages(stages);
  }
});

test('host pause freezes playback, resume re-syncs and a reload rejoins', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
    newStage(browser, { nickname: 'Dario' }),
  ]);
  try {
    const code = await assembleRoom(stages[0], stages.slice(1));
    await setSettings(stages[0]!.page, { clipSeconds: 60 });
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C, SONG_D]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);
    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'playing', 20000)),
    );
    const beforePause = playbackTiming(await stateOf(stages[0]!.page));

    await stages[0]!.page.getByTestId('host-pause').click();
    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'paused', 15000)),
    );

    await stages[0]!.page.getByTestId('host-resume').click();
    await Promise.all(
      stages.map((stage) => waitForPlaybackState(stage.page, 'playing', 15000)),
    );
    // FR-31: resume shifts the absolute timeline instead of restarting it.
    const afterResume = playbackTiming(await stateOf(stages[0]!.page));
    expect(afterResume.startAt).toBeGreaterThan(beforePause.startAt);
    const resumed = await readDiagnostics(stages[1]!.page);
    expect(resumed.plannedStart).toBe(afterResume.startAt);

    // AK-5 adjacent: a reload rejoins the same running playback and re-syncs.
    const dario = stages[3]!;
    await dario.page.goto(`/r/${code}?debug=1`);
    await expect(dario.page.getByTestId('room-view')).toBeVisible({
      timeout: 20000,
    });
    await unlockSound(dario.page);
    await waitForPlaybackState(dario.page, 'playing', 25000);
    const rejoined = playbackTiming(await stateOf(dario.page));
    expect(rejoined.index).toBe(0);
    const diagnostics = await readDiagnostics(dario.page);
    expect(diagnostics.plannedStart).toBe(afterResume.startAt);
    // A mid-clip rejoin starts late by definition, so first-start skew only
    // measures the reload. Sync means its media position catches up to the
    // shared timeline within the AK-7 window.
    await expect
      .poll(
        async () =>
          Math.abs((await readDiagnostics(dario.page)).driftMs ?? Infinity),
        { timeout: 10000 },
      )
      .toBeLessThanOrEqual(500);
  } finally {
    await closeStages(stages);
  }
});

test('consent gates playback traffic and privacy and flag gates hold', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
    newStage(browser, { nickname: 'Dario' }),
  ]);
  try {
    const [alice, bruno, cleo, dario] = stages;
    const code = await assembleRoom(alice, stages.slice(1));
    await setSettings(alice.page, { submissionSeconds: 30, clipSeconds: 60 });
    // Cleo picks "Ohne Videos" at the start gate and never grants the consent.
    await enterSubmission(
      stages.map((stage) => stage.page),
      { withoutVideos: [cleo.page] },
    );
    // Alice and Bruno submit the same video (linked), Dario a distinct one,
    // Cleo submits nothing: she stays an unconsenting participant listener.
    await submitSongViaUi(alice.page, watchUrl(SONG_A));
    await submitSongViaUi(bruno.page, watchUrl(SONG_A));
    await submitSongViaUi(dario.page, watchUrl(SONG_B));
    await expect
      .poll(() => submissionCount(alice.page), { timeout: 20000 })
      .toBe(3);
    for (const stage of [alice, bruno, dario]) {
      await enablePlaybackDebug(stage.page);
    }
    for (const stage of [alice, bruno, dario]) {
      await stage.page.getByTestId('finish-submission').click();
    }
    // Cleo never consents and never finishes: the deadline ends the phase.
    await waitForPhase(alice.page, 'PLAYBACK', 60000);
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'PLAYBACK', 60000)),
    );

    // Consent gate: no external YouTube traffic and an empty host node.
    expect(alice.youtubeRequests().length).toBeGreaterThan(0);
    await expect(
      cleo.page.getByTestId('playback-consent-required'),
    ).toBeVisible();
    await cleo.page.waitForTimeout(400);
    expect(cleo.youtubeRequests()).toEqual([]);
    await expect(cleo.page.getByTestId('playback-host')).toBeVisible();
    await expect(
      cleo.page.locator('[data-testid="playback-host"] iframe'),
    ).toHaveCount(0);
    await expect(
      cleo.page.locator('[data-testid="playback-thumbnail"]'),
    ).toHaveCount(0);

    await waitForPlaybackState(alice.page, 'playing', 20000);

    // FR-34/FR-26: an anonymous round keeps title/thumbnail but exposes no
    // owner identity anywhere in the playback DOM (no container, id or name).
    const alicePhase = alice.page.getByTestId('playback-phase');
    await expect(
      alice.page.getByTestId('playback-anonymous-note'),
    ).toBeVisible();
    await expect(alice.page.getByTestId('playback-owners')).toHaveCount(0);
    await expect(alice.page.getByTestId('playback-owner')).toHaveCount(0);
    await expect(alicePhase.locator('[data-owner-id]')).toHaveCount(0);
    const nicknameById = new Map<string, string>();
    for (const stage of stages) {
      nicknameById.set((await snapshot(stage.page)).clientId, stage.nickname);
    }
    const state = await stateOf(alice.page);
    const order = playbackOrder(state);
    const owners = ownerIndex(state);
    for (const ownerId of owners.get(order[0]!) ?? []) {
      const nickname = nicknameById.get(ownerId);
      if (nickname !== undefined) {
        await expect(alicePhase).not.toContainText(nickname);
      }
    }
    await expect(alice.page.getByTestId('playback-title')).toBeVisible();

    // Genre-Fail chip gate: own/linked songs get no bar, others get chip 0.
    const ownerIds = owners.get(order[0]!) ?? [];
    const aliceId = (await snapshot(alice.page)).clientId;
    const expectedEnabled = ownerIds.length > 0 && !ownerIds.includes(aliceId);
    const chip = alice.page.getByTestId('rating-chip-0');
    if (expectedEnabled) {
      await expect(chip).toBeEnabled();
      await expect(chip).toHaveAttribute('data-kind', 'genre-fail');
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      const given = (await stateOf(alice.page))?.round?.ratings[aliceId];
      expect(given?.[order[0]!]).toBe(0);
    } else {
      await expect(alice.page.getByTestId('rating-own')).toBeVisible();
      await expect(chip).toHaveCount(0);
    }

    // A second tab of the same identity takes over the write connection: the
    // superseded tab is a bound tab (read-only), not a spectator.
    const replacement = await cleo.context.newPage();
    await replacement.goto(`/r/${code}`);
    await expect(replacement.getByTestId('room-view')).toBeVisible({
      timeout: 20000,
    });
    await expect(cleo.page.getByTestId('read-only-indicator')).toBeVisible();
    await expect(cleo.page.getByTestId('playback-bound-tab')).toBeVisible();
    await ensureConsent(cleo.page);
    const cleoId = (await snapshot(cleo.page)).clientId;
    if ((owners.get(order[0]!) ?? []).includes(cleoId)) {
      await expect(cleo.page.getByTestId('rating-own')).toBeVisible();
    } else {
      await expect(cleo.page.getByTestId('rating-chip-0')).toBeDisabled();
    }

    // A genuinely new identity that joins mid-round is a spectator: it may not
    // rate. Check zero traffic before consent, then test the missing rating bar.
    const spectatorContext = await harnessContext(browser, {
      locale: 'en-US',
    });
    await installYouTubeFixture(spectatorContext, {});
    const spectator = await spectatorContext.newPage();
    const spectatorRequests = watchYouTubeRequests(spectator);
    await spectator.goto(`/r/${code}`);
    await joinRoom(spectator, code, 'Eve');
    await expect(spectator.getByTestId('playback-spectator')).toBeVisible();
    await spectator.waitForTimeout(400);
    expect(spectatorRequests()).toEqual([]);
    await unlockSound(spectator);
    await expect(spectator.getByTestId('rating-section')).toHaveCount(0);
    await expect(spectator.getByTestId('rating-chip-0')).toHaveCount(0);
    await spectatorContext.close();
  } finally {
    await closeStages(stages);
  }
});

test('the playback player is pre-warmed during SUBMISSION and reused into PLAYBACK', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [alice, bruno] = stages;
    await assembleRoom(alice, stages.slice(1));
    // Bruno picks "Ohne Videos"; submitting a song later grants the consent.
    await enterSubmission(
      stages.map((stage) => stage.page),
      { withoutVideos: [bruno.page] },
    );

    // (a) Before consent: the stable host slot exists, but there is no playback
    // iframe and no external YouTube traffic of any kind.
    await expect(bruno.page.getByTestId('playback-host')).toHaveCount(1);
    await expect(
      bruno.page.locator('[data-testid="playback-host"] iframe'),
    ).toHaveCount(0);
    expect(bruno.youtubeRequests()).toEqual([]);

    // Consenting inside SUBMISSION (via the submission panel) pre-warms the
    // player before PLAYBACK ever starts.
    await submitSongViaUi(alice.page, watchUrl(SONG_A));
    await submitSongViaUi(bruno.page, watchUrl(SONG_B));
    await submitSongViaUi(stages[2]!.page, watchUrl(SONG_C));

    const hostIframe = bruno.page.locator(
      '[data-testid="playback-host"] iframe',
    );
    const prewarmReady = async () =>
      (await youTubeCalls(bruno.page)).filter(
        (call) => call.type === 'ready' && !call.videoId,
      );
    // (b) Exactly one playback player is constructed during SUBMISSION, it is
    // marked, and it stays idle (no cue, no play).
    await expect(hostIframe).toHaveCount(1);
    await expect(
      bruno.page.locator(
        '[data-testid="playback-host"] iframe[data-playback-player="true"]',
      ),
    ).toHaveCount(1);
    await expect
      .poll(async () => (await prewarmReady()).length, { timeout: 10_000 })
      .toBe(1);
    expect(
      (await youTubeCalls(bruno.page)).filter(
        (call) => call.type === 'play' && !call.videoId,
      ),
    ).toEqual([]);
    // It is invisible to the user during SUBMISSION.
    await expect(bruno.page.getByTestId('playback-host')).toHaveAttribute(
      'data-warm',
      'true',
    );
    await expect(bruno.page.getByTestId('playback-host')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    // Mark the warmed iframe so we can prove it is the *same* DOM node later.
    await hostIframe.evaluate((element) => {
      (element as HTMLElement).dataset.prewarmMark = 'keep';
    });

    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    // (c) The same player instance/iframe survives into PLAYBACK: the marked
    // node is still the one in the host slot and no second player was built.
    await expect(
      bruno.page.locator(
        '[data-testid="playback-host"] iframe[data-prewarm-mark="keep"]',
      ),
    ).toHaveCount(1);
    await expect(hostIframe).toHaveCount(1);
    expect((await prewarmReady()).length).toBe(1);
    await expect(bruno.page.getByTestId('playback-host')).toHaveAttribute(
      'data-warm',
      'false',
    );

    // (d) Playback still starts within the existing ±500 ms bound, with no
    // pre-start audio leak on the warmed player.
    await waitForPlaybackState(bruno.page, 'playing', 20000);
    const diagnostics = await readDiagnostics(bruno.page);
    expect(diagnostics.status).toBe('playing');
    expect(diagnostics.observedStart).not.toBeNull();
    expect(Math.abs(diagnostics.startSkewMs ?? Infinity)).toBeLessThanOrEqual(
      500,
    );
    const timing = playbackTiming(await stateOf(bruno.page));
    expect(await preStartAudioLeaks(bruno.page, timing.startAt)).toEqual([]);
  } finally {
    await closeStages(stages);
  }
});

test('the video leads the playback stage, locked behind a pointer shield', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [alice] = stages;
    await assembleRoom(alice, stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitAll(stages, [SONG_A, SONG_B, SONG_C]);
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);
    await waitForPlaybackState(alice.page, 'playing', 20000);

    const page = alice.page;
    const iframe = page.locator('[data-testid="playback-host"] iframe');
    await expect(iframe).toHaveCount(1);

    // No YouTube UI: the embed URL carries the locked player parameters.
    const src = (await iframe.getAttribute('src')) ?? '';
    const embed = new URL(src);
    for (const [name, value] of Object.entries({
      controls: '0',
      disablekb: '1',
      fs: '0',
      rel: '0',
      iv_load_policy: '3',
      playsinline: '1',
    })) {
      expect(embed.searchParams.get(name), name).toBe(value);
    }

    // The shield covers the iframe's bounding box and takes every pointer
    // event: hover or click on the iframe centre (and near each corner) hits it.
    const shield = page.getByTestId('playback-shield');
    await expect(shield).toHaveCount(1);
    // elementFromPoint only sees the viewport: bring the whole video into it.
    await shield.scrollIntoViewIfNeeded();
    const iframeBox = await iframe.boundingBox();
    const shieldBox = await shield.boundingBox();
    expect(iframeBox).not.toBeNull();
    expect(shieldBox).not.toBeNull();
    expect(shieldBox!.x).toBeLessThanOrEqual(iframeBox!.x + 1);
    expect(shieldBox!.y).toBeLessThanOrEqual(iframeBox!.y + 1);
    expect(shieldBox!.x + shieldBox!.width).toBeGreaterThanOrEqual(
      iframeBox!.x + iframeBox!.width - 1,
    );
    expect(shieldBox!.y + shieldBox!.height).toBeGreaterThanOrEqual(
      iframeBox!.y + iframeBox!.height - 1,
    );
    const hits = await page.evaluate(
      ([x, y, width, height]) =>
        [
          [0.5, 0.5],
          [0.05, 0.05],
          [0.95, 0.05],
          [0.05, 0.95],
          [0.95, 0.95],
        ].map(
          ([fx, fy]) =>
            document
              .elementFromPoint(x! + width! * fx!, y! + height! * fy!)
              ?.getAttribute('data-testid') ?? null,
        ),
      [iframeBox!.x, iframeBox!.y, iframeBox!.width, iframeBox!.height],
    );
    expect(hits).toEqual(Array(5).fill('playback-shield'));
    // Hover and click on the video leave the playback untouched.
    await page.mouse.move(
      iframeBox!.x + iframeBox!.width / 2,
      iframeBox!.y + iframeBox!.height / 2,
    );
    await page.mouse.click(
      iframeBox!.x + iframeBox!.width / 2,
      iframeBox!.y + iframeBox!.height / 2,
    );
    expect((await readDiagnostics(page)).status).toBe('playing');

    // Stage order: video (16:9, full stage width up to 960 px), then the song
    // title, the rating bar, the timer and finally the compact card hand.
    const host = page.getByTestId('playback-host');
    const hostBox = await host.boundingBox();
    const phaseBox = await page.getByTestId('playback-phase').boundingBox();
    expect(hostBox).not.toBeNull();
    expect(phaseBox).not.toBeNull();
    expect(hostBox!.width / hostBox!.height).toBeGreaterThan(1.7);
    expect(hostBox!.width / hostBox!.height).toBeLessThan(1.85);
    expect(hostBox!.width).toBeGreaterThan(Math.min(960, phaseBox!.width) - 2);
    expect(hostBox!.width).toBeLessThanOrEqual(960.5);
    const tops: number[] = [];
    for (const id of [
      'playback-host',
      'playback-title',
      'rating-section',
      'playback-timer',
      'playback-hand',
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      tops.push(box!.y);
    }
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    // Compact cards: well below the full 124 x 172 size.
    const card = await page.getByTestId('song-card').first().boundingBox();
    expect(card!.height).toBeLessThan(150);
  } finally {
    await closeStages(stages);
  }
});

test('a failed pre-warm is retried when the playback plan arrives', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [alice, bruno, cleo] = stages;
    await assembleRoom(alice, stages.slice(1));
    await enterSubmission(stages.map((stage) => stage.page));
    await submitSongViaUi(alice.page, watchUrl(SONG_A));
    await submitSongViaUi(bruno.page, watchUrl(SONG_B));

    // Cleo's first iframe-API load (her SUBMISSION pre-warm) fails. The shared
    // script promise resets, so her preview load recovers it; the plan that
    // arrives at PLAYBACK must retry the pre-warm creation.
    await failIframeApi(cleo.page, 1);
    await submitSongViaUi(cleo.page, watchUrl(SONG_C));
    for (const stage of stages) {
      await enablePlaybackDebug(stage.page);
    }
    await finishToPlayback(stages);

    // Without the retry Cleo would stay 'skipped' for the whole round.
    await waitForPlaybackState(cleo.page, 'playing', 25000);
    const status = await playbackStatus(cleo.page);
    expect(status.state).toBe('playing');
    expect(status.errorCode).toBeNull();
    const diagnostics = await readDiagnostics(cleo.page);
    expect(diagnostics.status).toBe('playing');
    expect(diagnostics.observedStart).not.toBeNull();
  } finally {
    await closeStages(stages);
  }
});

/**
 * Deterministic controls for the audio-call helpers. Both helpers must date each
 * call from the session-clock value the fixture recorded *at the call*
 * (`YouTubeCall.serverAt`) — the same clock `playback.ts` compares against
 * `startAt`. They must never reconstruct a timestamp from the page's `Date.now`
 * / `performance.now`: mixing a 1 ms wall clock with a sub-millisecond monotonic
 * clock, or ignoring the client's wall-clock skew, misdated a legitimate
 * at-`startAt` unmute as a pre-start leak (the original m4-playback:705 flake).
 */
const DETECTOR_VIDEO = 'aaaaaaaaaaa';
const DETECTOR_START_AT = 1_000;
const DETECTOR_LOG: YouTubeCall[] = [
  // Preview traffic (another video) and the plan-less pre-warm unmute all
  // predate the playback cue and must not taint either walk.
  { type: 'state', at: 1, serverAt: 10, videoId: 'previewonly', state: 1 },
  { type: 'unmute', at: 2, serverAt: 11, videoId: 'previewonly' },
  { type: 'volume', at: 3, serverAt: 20, value: 70 },
  { type: 'unmute', at: 4, serverAt: 21 },
  // The playback player: clip cue, muted prebuffer, then playing.
  { type: 'cue', at: 5, serverAt: 100, videoId: DETECTOR_VIDEO },
  { type: 'mute', at: 6, serverAt: 101, videoId: DETECTOR_VIDEO },
  { type: 'volume', at: 7, serverAt: 102, value: 0, videoId: DETECTOR_VIDEO },
  { type: 'play', at: 8, serverAt: 103, videoId: DETECTOR_VIDEO },
  { type: 'state', at: 9, serverAt: 104, videoId: DETECTOR_VIDEO, state: 1 },
  // The muted pre-start play/seek are silent: neither audible nor a leak.
  { type: 'play', at: 10, serverAt: 105, videoId: DETECTOR_VIDEO },
  { type: 'pause', at: 11, serverAt: 106, videoId: DETECTOR_VIDEO },
  { type: 'seek', at: 12, serverAt: 107, seconds: 10, videoId: DETECTOR_VIDEO },
  { type: 'state', at: 13, serverAt: 108, videoId: DETECTOR_VIDEO, state: 1 },
  // Genuinely early: 100 ms before startAt, while the media is playing.
  { type: 'volume', at: 14, serverAt: 900, value: 70, videoId: DETECTOR_VIDEO },
  { type: 'unmute', at: 15, serverAt: 901, videoId: DETECTOR_VIDEO },
  // Exactly at startAt: accepted (no tolerance band either side).
  {
    type: 'volume',
    at: 16,
    serverAt: 1_000,
    value: 70,
    videoId: DETECTOR_VIDEO,
  },
  { type: 'unmute', at: 17, serverAt: 1_000, videoId: DETECTOR_VIDEO },
  // Audible from here on: a real start play and a drift-correction seek.
  { type: 'play', at: 18, serverAt: 1_100, videoId: DETECTOR_VIDEO },
  {
    type: 'seek',
    at: 19,
    serverAt: 1_200,
    seconds: 12,
    videoId: DETECTOR_VIDEO,
  },
];

const DETECTOR_EARLY_LEAKS = ['volume@900', 'unmute@901'];
const DETECTOR_AUDIBLE_PLAY = ['play@1100'];
const DETECTOR_AUDIBLE_SEEK = ['seek@1200'];

function callKeys(calls: readonly (AudibleCall | PreStartLeak)[]): string[] {
  return calls.map((entry) => `${entry.call.type}@${entry.serverAt}`);
}

test.describe('audio-call helpers', () => {
  test('the leak detector rejects early calls and accepts calls exactly at startAt', () => {
    expect(
      callKeys(detectPreStartLeaks(DETECTOR_LOG, DETECTOR_START_AT)),
    ).toEqual(DETECTOR_EARLY_LEAKS);
    // One millisecond earlier is still a leak: the boundary is exact.
    expect(
      callKeys(detectPreStartLeaks(DETECTOR_LOG, DETECTOR_START_AT + 1)),
    ).toEqual([...DETECTOR_EARLY_LEAKS, 'volume@1000', 'unmute@1000']);
    // The audible walk reports the recorded session time, not a reconstruction.
    expect(
      callKeys(classifyAudibleCalls(DETECTOR_LOG, DETECTOR_VIDEO, 'play')),
    ).toEqual(DETECTOR_AUDIBLE_PLAY);
    expect(
      callKeys(classifyAudibleCalls(DETECTOR_LOG, DETECTOR_VIDEO, 'seek')),
    ).toEqual(DETECTOR_AUDIBLE_SEEK);
  });

  test('the call-log helpers ignore the client wall clock and its skew', async ({
    browser,
  }) => {
    for (const wallClockOffsetMs of [3_000, -3_000]) {
      const stage = await newStage(browser, {
        nickname: 'Skew',
        wallClockOffsetMs,
      });
      try {
        await stage.page.evaluate((log) => {
          window.__bangerYtCalls = log;
        }, DETECTOR_LOG);
        expect(
          callKeys(await preStartAudioLeaks(stage.page, DETECTOR_START_AT)),
        ).toEqual(DETECTOR_EARLY_LEAKS);
        expect(
          callKeys(await audibleCalls(stage.page, DETECTOR_VIDEO, 'play')),
        ).toEqual(DETECTOR_AUDIBLE_PLAY);
        // A wall-clock adjustment *after* the calls were recorded must not move
        // any of them: each timestamp was captured at call time.
        await stage.page.evaluate(() => {
          const real = Date.now.bind(Date);
          Date.now = () => real() + 4_321;
        });
        expect(
          callKeys(await preStartAudioLeaks(stage.page, DETECTOR_START_AT)),
        ).toEqual(DETECTOR_EARLY_LEAKS);
        expect(
          callKeys(await audibleCalls(stage.page, DETECTOR_VIDEO, 'seek')),
        ).toEqual(DETECTOR_AUDIBLE_SEEK);
      } finally {
        await closeStages([stage]);
      }
    }
  });
});
