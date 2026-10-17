import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';
import {
  assembleRoom,
  closeStages,
  dispatch,
  ensureConsent,
  enterSubmission,
  newStage,
  setSettings,
  snapshot,
  startPlayingPreview,
  stateOf,
  submitSongViaUi,
  unlockSound,
  waitForPhase,
  type Stage,
} from './m3-support';

/**
 * M3 consumer coverage: genre roulette (FR-10/11, AK-1) and the song submission
 * flow (FR-20..26, AK-2/3/6). Every scenario drives the real UI, the real
 * `GameSession` and the real engine; the external YouTube edge (iframe API,
 * embed host, thumbnail, `/api/oembed`) is the only replaced boundary.
 *
 * Deterministic fixture ids are 11 chars so `parseYouTubeLink` accepts them and
 * every `Media`/`Song` passes the shared schemas.
 */
const VALID_A = 'dQw4w9WgXcQ';
const VALID_B = 'kJQP7kiw5Fk';
const VALID_D = '3JZ_D3ELwOQ';
const DUPLICATE = 'fJ9rUzIMcZQ';
const BLOCKED_100 = 'M7lc1UVf-VE';
const BLOCKED_101 = 'oHg5SJYRHA0';
const BLOCKED_150 = 'ZbZSe6N_BXs';
const STALE_A = 'e-ORhEE9VVg';
const STALE_B = 'RgKAFK5djSk';

declare global {
  interface Window {
    __m3Token?: string;
  }
}

/** Supported watch link form (FR-20) shared by every submission call site. */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function mediaFrom(videoId: string, startSeconds = 0): Media {
  return {
    videoId,
    title: fixtureTitle(videoId),
    channel: FIXTURE_CHANNEL,
    thumbnail: fixtureThumbnail(videoId),
    durationSeconds: 200,
    startSeconds,
  };
}

function trackPageErrors(pages: readonly Page[]): string[] {
  const errors: string[] = [];
  for (const page of pages) {
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
  }
  return errors;
}

async function waitForSubmissionMedia(
  page: Page,
  playerId: string,
  videoId: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await stateOf(page))?.round?.submissions?.[playerId]?.media.videoId,
      { timeout: 10000 },
    )
    .toBe(videoId);
}

async function submitDistinctSong(
  stage: Stage,
  videoId: string,
): Promise<void> {
  await submitSongViaUi(stage.page, watchUrl(videoId));
  await waitForSubmissionMedia(
    stage.page,
    (await snapshot(stage.page)).clientId,
    videoId,
  );
}

test('four players see one deterministic wheel and the same localized genre', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', locale: 'en-US' }),
    newStage(browser, { nickname: 'Bruno', locale: 'en-US' }),
    newStage(browser, { nickname: 'Cleo', locale: 'en-US' }),
    newStage(browser, {
      nickname: 'Dario',
      locale: 'de-DE',
      reducedMotion: 'reduce',
      viewport: { width: 360, height: 640 },
    }),
  ]);
  try {
    const [host, ...rest] = stages;
    const errors = trackPageErrors(stages.map((stage) => stage.page));
    await assembleRoom(host, rest);
    for (const stage of stages) {
      await unlockSound(stage.page);
    }
    const initialPool = (await stateOf(host.page))?.remainingGenreIds ?? [];
    await host.page.getByTestId('start-game').click();
    await waitForPhase(host.page, 'GENRE_SPIN');
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'GENRE_SPIN')),
    );

    // Read the wheel before the 3s spin deadline unmounts it.
    const readGenreUi = async (stage: Stage) => {
      const wheel = stage.page.getByTestId('genre-wheel');
      const result = stage.page.getByTestId('genre-result');
      await expect(wheel).toBeVisible({ timeout: 2500 });
      await expect(result).toHaveText(/.+/, { timeout: 2500 });
      return {
        genreId: await wheel.getAttribute('data-genre-id'),
        angle: await wheel.getAttribute('data-target-angle'),
        result: await result.innerText(),
      };
    };
    const readings = await Promise.all(stages.map(readGenreUi));

    const state = await stateOf(host.page);
    const genre = state?.round?.genre;
    expect(genre).toBeDefined();
    if (genre === undefined) {
      return;
    }
    // FR-11: the drawn genre leaves the pool until the list is exhausted.
    expect(state?.remainingGenreIds).toEqual(
      initialPool.filter((id) => id !== genre.id),
    );
    expect(state?.remainingGenreIds).not.toContain(genre.id);
    for (const reading of readings) {
      expect(reading.genreId).toBe(genre.id);
      expect(reading.angle).toMatch(/^-?\d+(?:\.\d+)?$/);
    }
    // Same target on every client, including reduced motion and 360px.
    expect(new Set(readings.map((reading) => reading.genreId)).size).toBe(1);
    expect(new Set(readings.map((reading) => reading.angle)).size).toBe(1);
    for (const reading of readings.slice(0, 3)) {
      expect(reading.result).toContain(genre.en);
    }
    expect(readings[3].result).toContain(genre.de);

    const widths = await stages[3].page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.inner);

    // AK-9: the M3 copy switches language without a reload.
    await waitForPhase(host.page, 'SUBMISSION');
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'SUBMISSION')),
    );
    const roomView = stages[0].page.getByTestId('room-view');
    const beforeText = await roomView.innerText();
    await stages[0].page.evaluate(() => {
      window.__m3Token = 'alive';
    });
    await stages[0].page.getByTestId('language-switch').selectOption('de');
    await expect(stages[0].page.locator('html')).toHaveAttribute('lang', 'de');
    expect(await stages[0].page.evaluate(() => window.__m3Token)).toBe('alive');
    expect(await roomView.innerText()).not.toBe(beforeText);

    expect(errors).toEqual([]);
  } finally {
    await closeStages(stages);
  }
});

test('duplicate links collapse to one song with the first start and stay anonymous', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
    newStage(browser, { nickname: 'Dario' }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    await enterSubmission(stages.map((stage) => stage.page));
    const bruno = stages[1];
    const cleo = stages[2];
    const brunoId = (await snapshot(bruno.page)).clientId;
    const cleoId = (await snapshot(cleo.page)).clientId;

    await submitDistinctSong(stages[0], VALID_A);
    await submitDistinctSong(stages[3], VALID_D);

    // Bruno submits the shared video first, at start 10s.
    await ensureConsent(bruno.page);
    await startPlayingPreview(bruno.page, `https://youtu.be/${DUPLICATE}?t=9s`);
    await expect(bruno.page.getByTestId('start-seconds')).toHaveValue('9');
    await bruno.page.getByTestId('start-plus-1').click();
    await expect(bruno.page.getByTestId('start-seconds')).toHaveValue('10');
    await bruno.page.getByTestId('save-submission').click();
    await waitForSubmissionMedia(host.page, brunoId, DUPLICATE);

    // Cleo submits the same video later at a different start (20s).
    await ensureConsent(cleo.page);
    await startPlayingPreview(cleo.page, watchUrl(DUPLICATE));
    for (let index = 0; index < 4; index += 1) {
      await cleo.page.getByTestId('start-plus-5').click();
    }
    await expect(cleo.page.getByTestId('start-seconds')).toHaveValue('20');
    await cleo.page.getByTestId('save-submission').click();
    await waitForSubmissionMedia(host.page, cleoId, DUPLICATE);

    const drafted = await stateOf(host.page);
    expect(drafted?.round?.submissions?.[brunoId]?.media.startSeconds).toBe(10);
    expect(drafted?.round?.submissions?.[cleoId]?.media.startSeconds).toBe(20);
    // AK-3: the progress list never reveals another player's media.
    const progress = host.page.getByTestId('submission-progress');
    await expect(progress).not.toContainText(fixtureTitle(DUPLICATE));

    for (const stage of stages.slice(0, 3)) {
      await stage.page.getByTestId('finish-submission').click();
    }
    await expect(host.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-count',
      '3',
    );
    await stages[3].page.getByTestId('finish-submission').click();
    await waitForPhase(host.page, 'PLAYBACK');

    const settled = await stateOf(host.page);
    const songs = settled?.round?.songs ?? [];
    expect(songs).toHaveLength(3);
    const linked = songs.find((song) => song.media.videoId === DUPLICATE);
    expect(linked).toBeDefined();
    expect(linked?.ownerIds).toHaveLength(2);
    expect(new Set(linked?.ownerIds)).toEqual(new Set([brunoId, cleoId]));
    // The first submitter (Bruno) wins the start point.
    expect(linked?.media.startSeconds).toBe(10);

    // FR-26/AK-3: the linked animation names no owner while anonymous.
    const animation = host.page.getByTestId('linked-animation');
    await expect(animation).toBeVisible({ timeout: 5000 });
    const animationText = (await animation.innerText()).toLowerCase();
    expect(animationText).not.toContain(bruno.nickname.toLowerCase());
    expect(animationText).not.toContain(cleo.nickname.toLowerCase());
  } finally {
    await closeStages(stages);
  }
});

test('forbidden embeds are blocked and consent gates external YouTube traffic', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const videos = {
    [BLOCKED_100]: { error: 100 },
    [BLOCKED_101]: { error: 101 },
    [BLOCKED_150]: { error: 150 },
    [VALID_D]: { duration: 200, currentSeconds: 200 },
  };
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', videos }),
    newStage(browser, { nickname: 'Bruno', videos }),
    newStage(browser, { nickname: 'Cleo', videos }),
    newStage(browser, { nickname: 'Dario', videos }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    // Dario picks "Ohne Videos" at the start gate: audio on, no consent.
    await enterSubmission(
      stages.map((stage) => stage.page),
      { withoutVideos: [stages[3].page] },
    );

    const forbidden: Array<[Stage, string, string]> = [
      [stages[0], BLOCKED_100, '100'],
      [stages[1], BLOCKED_101, '101'],
      [stages[2], BLOCKED_150, '150'],
    ];
    for (const [stage, videoId, code] of forbidden) {
      const playerId = (await snapshot(stage.page)).clientId;
      await ensureConsent(stage.page);
      await stage.page.getByTestId('song-link').fill(watchUrl(videoId));
      await stage.page.getByTestId('load-preview').click();
      const status = stage.page.getByTestId('preview-status');
      await expect(status).toHaveAttribute('data-state', 'error', {
        timeout: 15000,
      });
      await expect(status).toHaveAttribute('data-error-code', code);
      await expect(stage.page.getByTestId('preview-error')).toBeVisible();
      await expect(stage.page.getByTestId('save-submission')).toBeDisabled();
      const state = await stateOf(host.page);
      expect(state?.round?.submissions?.[playerId]).toBeUndefined();
    }

    // Consent gate: nothing external may load before the consent is granted.
    const dario = stages[3];
    const external = dario.youtubeRequests;
    await dario.page.getByTestId('song-link').fill(watchUrl(VALID_D));
    await expect(dario.page.getByTestId('load-preview')).toBeDisabled();
    await expect(
      dario.page.getByTestId('submission-consent-required'),
    ).toBeVisible();
    await dario.page.waitForTimeout(300);
    expect(external()).toEqual([]);
    await expect(dario.page.getByTestId('save-submission')).toBeDisabled();

    await ensureConsent(dario.page);
    await dario.page.getByTestId('load-preview').click();
    const status = dario.page.getByTestId('preview-status');
    await expect(status).toHaveAttribute('data-state', 'ready', {
      timeout: 15000,
    });
    await dario.page.getByTestId('preview-play').click();
    await expect(status).toHaveAttribute('data-state', 'playing', {
      timeout: 15000,
    });
    const requested = external();
    expect(requested.some((url) => url.includes('/iframe_api'))).toBe(true);
    expect(
      requested.some((url) => url.includes('www.youtube-nocookie.com/embed/')),
    ).toBe(true);

    await dario.page.getByTestId('set-start').click();
    // Selecting the advancing playhead at the end stays inside the video.
    await expect(dario.page.getByTestId('start-seconds')).toHaveValue('199');
    await dario.page.getByTestId('save-submission').click();
    const darioId = (await snapshot(dario.page)).clientId;
    await waitForSubmissionMedia(host.page, darioId, VALID_D);
    const saved = await stateOf(host.page);
    expect(saved?.round?.submissions?.[darioId]?.media.startSeconds).toBe(199);
    expect(saved?.round?.submissions?.[darioId]?.media.title).toBe(
      fixtureTitle(VALID_D),
    );
  } finally {
    await closeStages(stages);
  }
});

test('a retained draft survives reload and finishing is irreversible', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    await enterSubmission(stages.map((stage) => stage.page));
    const alice = stages[0];
    const aliceId = (await snapshot(alice.page)).clientId;

    // A chosen link start plus fine adjustment must survive save and reload.
    await submitSongViaUi(alice.page, `${watchUrl(VALID_A)}&t=10`, {
      plus5: 1,
    });
    const chosenStart = 15;
    await waitForSubmissionMedia(host.page, aliceId, VALID_A);
    const drafted = await stateOf(host.page);
    expect(drafted?.round?.submissions?.[aliceId]?.media.startSeconds).toBe(
      chosenStart,
    );
    await expect(alice.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-count',
      '0',
    );
    await expect(alice.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-total',
      '3',
    );

    await alice.page.reload();
    await expect(alice.page.getByTestId('room-view')).toBeVisible({
      timeout: 20000,
    });
    await unlockSound(alice.page);
    // Reload briefly drops a three-player round below quorum. The successor
    // must explicitly resume; sound unlock is not an automatic resume.
    const recovered = await stateOf(alice.page);
    expect(recovered?.pause?.reason).toBe('quorum');
    const replicas = await Promise.all(
      stages.map((stage) => snapshot(stage.page)),
    );
    const successor =
      stages[
        replicas.findIndex((replica) => replica.clientId === recovered?.hostId)
      ];
    await successor.page.getByTestId('host-resume').click();
    await expect
      .poll(async () => (await stateOf(alice.page))?.pause)
      .toBeNull();
    await expect(alice.page.getByTestId('song-link')).toHaveValue(
      new RegExp(VALID_A),
    );
    await expect(alice.page.getByTestId('start-seconds')).toHaveValue(
      String(chosenStart),
    );
    await expect(alice.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-count',
      '0',
    );
    await expect(alice.page.getByTestId('finish-submission')).toBeEnabled();

    // Finishing locks the round entry for good.
    await alice.page.getByTestId('finish-submission').click();
    await expect
      .poll(async () => {
        const state = await stateOf(host.page);
        return state?.round?.submissionDoneIds.includes(aliceId) ?? false;
      })
      .toBe(true);
    await expect(alice.page.getByTestId('submission-finished')).toBeVisible();
    const lateSubmit = await dispatch(alice.page, {
      type: 'SUBMIT_SONG',
      media: mediaFrom(VALID_B),
    });
    expect(lateSubmit).toEqual({ status: 'rejected', reason: 'FORBIDDEN' });
    const lateRemove = await dispatch(alice.page, {
      type: 'REMOVE_SUBMISSION',
    });
    expect(lateRemove).toEqual({ status: 'rejected', reason: 'FORBIDDEN' });
    expect(
      (await stateOf(host.page))?.round?.submissions?.[aliceId]?.media,
    ).toEqual(drafted?.round?.submissions?.[aliceId]?.media);
    await expect(alice.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-count',
      '1',
    );
  } finally {
    await closeStages(stages);
  }
});

test('a player who misses the submission deadline skips the round', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    await setSettings(host.page, { submissionSeconds: 30 });
    await enterSubmission(stages.map((stage) => stage.page));
    const cleo = stages[2];
    const cleoId = (await snapshot(cleo.page)).clientId;

    await submitDistinctSong(stages[0], VALID_A);
    await submitDistinctSong(stages[1], VALID_B);
    await stages[0].page.getByTestId('finish-submission').click();
    await stages[1].page.getByTestId('finish-submission').click();
    await expect(host.page.getByTestId('submission-progress')).toHaveAttribute(
      'data-count',
      '2',
    );

    // Cleo submits nothing: the phase only ends when the deadline elapses.
    await waitForPhase(host.page, 'PLAYBACK', 45_000);
    const state = await stateOf(host.page);
    expect(state?.round?.submissions?.[cleoId]).toBeUndefined();
    expect(state?.round?.participantIds).toContain(cleoId);
    expect(state?.players?.[cleoId]?.status).toBe('player');
    expect(
      (state?.round?.songs ?? []).map((song) => song.media.videoId).sort(),
    ).toEqual([VALID_A, VALID_B].sort());
  } finally {
    await closeStages(stages);
  }
});

test('a stale preview cannot validate a replaced link', async ({ browser }) => {
  test.setTimeout(90_000);
  const videos = {
    [STALE_A]: { error: 101, errorDelayMs: 1500 },
    [STALE_B]: {},
  };
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice', videos }),
    newStage(browser, { nickname: 'Bruno', videos }),
    newStage(browser, { nickname: 'Cleo', videos }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    await enterSubmission(stages.map((stage) => stage.page));
    const alice = stages[0];
    const aliceId = (await snapshot(alice.page)).clientId;

    await ensureConsent(alice.page);
    await alice.page.getByTestId('song-link').fill(watchUrl(STALE_A));
    await alice.page.getByTestId('load-preview').click();
    // Replace the link before the slow stale error can arrive.
    await alice.page.getByTestId('song-link').fill(watchUrl(STALE_B));
    await alice.page.getByTestId('load-preview').click();
    const status = alice.page.getByTestId('preview-status');
    await expect(status).toHaveAttribute('data-state', 'ready', {
      timeout: 15000,
    });
    await alice.page.getByTestId('preview-play').click();
    await expect(status).toHaveAttribute('data-state', 'playing', {
      timeout: 15000,
    });

    // Past the stale error deadline the replacement preview must stay valid.
    await alice.page.waitForTimeout(1800);
    await expect(status).toHaveAttribute('data-state', 'playing');
    await expect(status).not.toHaveAttribute('data-error-code', /./);
    await alice.page.getByTestId('save-submission').click();
    await waitForSubmissionMedia(host.page, aliceId, STALE_B);
    const saved = await stateOf(host.page);
    expect(saved?.round?.submissions?.[aliceId]?.media.title).toBe(
      fixtureTitle(STALE_B),
    );
  } finally {
    await closeStages(stages);
  }
});

test('pause and tab takeover discard old preview validation', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
    newStage(browser, { nickname: 'Dario' }),
  ]);
  try {
    const [host, bruno, ...rest] = stages;
    const code = await assembleRoom(host, [bruno, ...rest]);
    await enterSubmission(stages.map((stage) => stage.page));
    await ensureConsent(bruno.page);
    await startPlayingPreview(bruno.page, watchUrl(VALID_B));
    await expect(bruno.page.getByTestId('save-submission')).toBeEnabled();

    await host.page.getByTestId('host-pause').click();
    await expect(bruno.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    await expect(
      bruno.page.locator('[data-testid="preview-host"] iframe'),
    ).toHaveCount(0);
    await host.page.getByTestId('host-resume').click();
    await expect(bruno.page.getByTestId('save-submission')).toBeDisabled();
    await startPlayingPreview(bruno.page, watchUrl(VALID_B));
    await expect(bruno.page.getByTestId('save-submission')).toBeEnabled();

    const replacement = await bruno.context.newPage();
    await replacement.goto(`/r/${code}`);
    await expect(replacement.getByTestId('room-view')).toBeVisible();
    await expect(bruno.page.getByTestId('read-only-indicator')).toBeVisible();
    await expect(bruno.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    await expect(
      bruno.page.locator('[data-testid="preview-host"] iframe'),
    ).toHaveCount(0);
    const stale = await dispatch(bruno.page, {
      type: 'SUBMIT_SONG',
      media: mediaFrom(VALID_B),
    });
    expect(stale.status).toBe('rejected');
    const brunoId = (await snapshot(replacement)).clientId;
    expect(
      (await stateOf(host.page))?.round?.submissions?.[brunoId],
    ).toBeUndefined();
    // The stored consent carries over, only the one-tap sound gate remains.
    await unlockSound(replacement);
    await submitSongViaUi(replacement, watchUrl(VALID_B));
    await waitForSubmissionMedia(host.page, brunoId, VALID_B);
  } finally {
    await closeStages(stages);
  }
});
