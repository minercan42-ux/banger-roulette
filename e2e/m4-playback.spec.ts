import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
import {
  assembleRoom,
  closeStages,
  enterSubmission,
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
  consentToPlayback,
  enablePlaybackDebug,
  playbackStatus,
  playbackTiming,
  readDiagnostics,
  waitForPlaybackIndex,
  waitForPlaybackState,
} from './m4-support';
import {
  installYouTubeFixture,
  setFixtureVideo,
  watchYouTubeRequests,
  youTubeCalls,
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
    const nows = await Promise.all(
      stages.map((stage) =>
        stage.page.evaluate(() => window.__banger!.session.now()),
      ),
    );
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const localTiming = playbackTiming(await stateOf(stage.page));
      expect(localTiming.startAt).toBe(timing.startAt);
      // No playback before the agreed start, whenever the read lands early.
      if (nows[index]! >= timing.startAt - 100) {
        continue;
      }
      const before = await playbackStatus(stage.page);
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

    const seekTargets = async (stage: Stage) =>
      (await youTubeCalls(stage.page)).filter(
        (call) => call.type === 'seek' && call.videoId === videoId,
      );
    // FR-32: only the >750 ms client seeks, and it converges back under 750.
    expect((await seekTargets(stages[0]!)).length).toBeGreaterThanOrEqual(1);
    expect((await seekTargets(stages[1]!)).length).toBe(0);
    expect((await seekTargets(stages[2]!)).length).toBe(0);

    for (const stage of stages) {
      const diagnostics = await readDiagnostics(stage.page);
      expect(diagnostics.status).toBe('playing');
      expect(Math.abs(diagnostics.driftMs ?? 0)).toBeLessThanOrEqual(750);
    }
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
    [SONG_A]: { bufferingMs: 1_200 },
    [SONG_B]: { bufferingMs: 1_200 },
    [SONG_C]: { bufferingMs: 1_200 },
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
      const seeks = (await youTubeCalls(stage.page)).filter(
        (call) => call.type === 'seek' && call.videoId === videoId,
      );
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
    for (const videoId of [SONG_A, SONG_B, SONG_C]) {
      await setFixtureVideo(stages[0]!.page, videoId, {
        autoplayBlocked: true,
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
    await consentToPlayback(dario.page);
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
    await enterSubmission(stages.map((stage) => stage.page));
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
    await expect(cleo.page.getByTestId('playback-consent')).toBeVisible();
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

    // Genre-Fail gate: own/linked songs are never targets, others are.
    const ownerIds = owners.get(order[0]!) ?? [];
    const aliceId = (await snapshot(alice.page)).clientId;
    const expectedEnabled = ownerIds.length > 0 && !ownerIds.includes(aliceId);
    const flag = alice.page.getByTestId('playback-flag');
    if (expectedEnabled) {
      await expect(flag).toBeEnabled();
      await flag.click();
      await expect(flag).toHaveAttribute('data-flagged', 'true');
      await expect(flag).toBeDisabled();
      const flagged = (await stateOf(alice.page))?.round?.genreFailFlags[
        aliceId
      ];
      expect(flagged).toContain(order[0]!);
    } else {
      await expect(flag).toBeDisabled();
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
    await cleo.page.getByTestId('playback-consent').check();
    const boundFlag = cleo.page.getByTestId('playback-flag');
    await expect(boundFlag).toBeVisible();
    await expect(boundFlag).toBeDisabled();

    // A genuinely new identity that joins mid-round is a spectator: it may not
    // flag. Check zero traffic before consent, then test the visible flag gate.
    const spectatorContext = await browser.newContext({ locale: 'en-US' });
    await installYouTubeFixture(spectatorContext, {});
    const spectator = await spectatorContext.newPage();
    const spectatorRequests = watchYouTubeRequests(spectator);
    await spectator.goto(`/r/${code}`);
    await joinRoom(spectator, code, 'Eve');
    await expect(spectator.getByTestId('playback-spectator')).toBeVisible();
    await spectator.waitForTimeout(400);
    expect(spectatorRequests()).toEqual([]);
    await spectator.getByTestId('playback-consent').check();
    const spectatorFlag = spectator.getByTestId('playback-flag');
    await expect(spectatorFlag).toBeVisible();
    await expect(spectatorFlag).toBeDisabled();
    await spectatorContext.close();
  } finally {
    await closeStages(stages);
  }
});
