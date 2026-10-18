import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Media } from '../src/shared/primitives';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
  releaseFixtureVideo,
  youTubeCalls,
  type YouTubeFixtureMap,
} from './youtube-fixture';
import {
  assembleRoom,
  closeStages,
  dispatch,
  ensureConsent,
  enterSubmission,
  expectPreviewNotLoaded,
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
    __reelMarks?: { plateIn?: number; spinOut?: number };
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

/** Waits until the host holds this video for the player (at this start, if given). */
async function waitForSubmissionMedia(
  page: Page,
  playerId: string,
  videoId: string,
  startSeconds?: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const media = (await stateOf(page))?.round?.submissions?.[playerId]
          ?.media;
        if (media === undefined || startSeconds === undefined) {
          return media?.videoId;
        }
        return `${media.videoId}@${media.startSeconds}`;
      },
      { timeout: 10000 },
    )
    .toBe(startSeconds === undefined ? videoId : `${videoId}@${startSeconds}`);
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
    await host.page.evaluate(() => {
      const marks: { plateIn?: number; spinOut?: number } = {};
      window.__reelMarks = marks;
      const scan = () => {
        const at = performance.now();
        if (
          marks.plateIn === undefined &&
          document.querySelector('[data-testid="genre-plate"]')
        ) {
          marks.plateIn = at;
        }
        if (
          marks.plateIn !== undefined &&
          marks.spinOut === undefined &&
          !document.querySelector('[data-testid="genre-spin"]')
        ) {
          marks.spinOut = at;
        }
      };
      new MutationObserver(scan).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    await host.page.getByTestId('start-game').click();
    await waitForPhase(host.page, 'GENRE_SPIN');
    await Promise.all(
      stages.map((stage) => waitForPhase(stage.page, 'GENRE_SPIN')),
    );

    // Read the reel before the 5.5s spin deadline unmounts it.
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

    // The result stays visible for at least 2 s after the reel stops (the
    // plate pops in at the stop) before the phase ends, and the chosen genre
    // stays on the table as a plate at the top of SUBMISSION.
    const marks = await host.page.evaluate(() => window.__reelMarks);
    expect(marks?.plateIn).toBeDefined();
    expect(marks?.spinOut).toBeDefined();
    expect(
      (marks?.spinOut ?? 0) - (marks?.plateIn ?? 0),
    ).toBeGreaterThanOrEqual(2000);
    for (const stage of stages) {
      const plate = stage.page
        .getByTestId('submission-panel')
        .getByTestId('genre-plate');
      await expect(plate).toBeVisible();
      await expect(plate).toContainText(
        stage === stages[3] ? genre.de : genre.en,
      );
    }
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

/**
 * Measures a genre plate inside `[data-testid=scope]`. A running `br-bump` is
 * paused at its 40% keyframe (the peak: scale 1.18, tilt -3deg) first, so the
 * numbers describe the widest the name ever gets. `insideClip` is true when
 * the name's box stays inside its nearest clipping ancestor (the viewport when
 * none clips).
 */
async function plateFits(page: Page, scope: string) {
  return page.evaluate(async (testId) => {
    const plate = document
      .querySelector(`[data-testid="${testId}"]`)!
      .querySelector<HTMLElement>('[data-testid="genre-plate"]')!;
    const name = plate.querySelector<HTMLElement>('.br-genre__name')!;
    await Promise.all(plate.getAnimations().map((a) => a.finished));
    // Wrapping at rest: no clipped line in the name or on the plate.
    const nameFits = name.scrollHeight <= name.clientHeight + 1;
    const plateFits = plate.scrollHeight <= plate.clientHeight + 1;
    const bumps = name
      .getAnimations()
      .filter((a) => (a as CSSAnimation).animationName === 'br-genre-bump');
    for (const bump of bumps) {
      const timing = bump.effect!.getComputedTiming();
      bump.pause();
      bump.currentTime = Number(timing.delay) + 0.4 * Number(timing.duration);
    }
    let clip: DOMRect = new DOMRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight,
    );
    for (
      let node = name.parentElement;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (getComputedStyle(node).overflowX !== 'visible') {
        clip = node.getBoundingClientRect();
        break;
      }
    }
    const box = name.getBoundingClientRect();
    const frame = plate.getBoundingClientRect();
    return {
      bumps: bumps.length,
      nameFits,
      plateFits,
      plateFitsWidth: plate.scrollWidth <= plate.clientWidth + 1,
      insideClip: box.left >= clip.left - 0.5 && box.right <= clip.right + 0.5,
      insidePlate:
        box.left >= frame.left - 0.5 &&
        box.right <= frame.right + 0.5 &&
        box.top >= frame.top - 0.5 &&
        box.bottom <= frame.bottom + 0.5,
      text: name.textContent,
    };
  }, scope);
}

test('an 80-character custom genre is shown whole on the plate and in two whole lines on the reel', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stages = await Promise.all([
    newStage(browser, {
      nickname: 'Alice',
      locale: 'en-US',
      viewport: { width: 360, height: 740 },
    }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    const wide = 'W'.repeat(80);
    const wideM = 'M'.repeat(80);
    await setSettings(host.page, {
      genre: {
        mode: 'custom',
        items: [
          { id: 'long-wide', de: wide, en: wide },
          { id: 'long-m', de: wideM, en: wideM },
        ],
      },
    });
    for (const stage of stages) {
      await unlockSound(stage.page);
    }
    await host.page.getByTestId('start-game').click();
    await waitForPhase(host.page, 'GENRE_SPIN');

    // The stopped reel: every row holds at most two whole lines (the name box
    // is an exact multiple of the line height and sits inside the fixed row).
    const hold = host.page.getByTestId('genre-spin').getByTestId('genre-plate');
    await expect(hold).toBeVisible({ timeout: 6000 });
    const reel = await host.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.br-reel__row')].map(
        (row) => {
          const name = row.querySelector<HTMLElement>('.br-reel__name')!;
          const lineHeight = parseFloat(getComputedStyle(name).lineHeight);
          return {
            lines: name.clientHeight / lineHeight,
            fontSize: parseFloat(getComputedStyle(name).fontSize),
            nameHeight: name.offsetHeight,
            rowHeight: row.clientHeight,
            text: name.textContent,
          };
        },
      ),
    );
    expect(reel.length).toBeGreaterThan(0);
    for (const row of reel) {
      expect(row.lines).toBeLessThanOrEqual(2.05);
      expect(Math.abs(row.lines - Math.round(row.lines))).toBeLessThan(0.05);
      expect(row.nameHeight).toBeLessThanOrEqual(row.rowHeight);
      expect(row.fontSize).toBeGreaterThanOrEqual(12);
      // The whole name stays in the DOM, the ellipsis is only visual.
      expect([wide, wideM]).toContain(row.text);
    }

    // The plate in the hold and the one in SUBMISSION show the full name.
    const held = await plateFits(host.page, 'genre-spin');
    expect(held.nameFits).toBe(true);
    expect(held.plateFits).toBe(true);
    expect(held.plateFitsWidth).toBe(true);
    expect(held.insideClip).toBe(true);
    expect(held.insidePlate).toBe(true);
    // Wrapping names skip the repeating bump: only the pop-in runs.
    expect(held.bumps).toBe(0);
    expect([wide, wideM]).toContain(held.text);
    const heldWidths = await host.page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(heldWidths.scroll).toBeLessThanOrEqual(heldWidths.inner);
    await waitForPhase(host.page, 'SUBMISSION');
    const kept = await plateFits(host.page, 'submission-panel');
    expect(kept.nameFits).toBe(true);
    expect(kept.plateFits).toBe(true);
    expect(kept.plateFitsWidth).toBe(true);
    expect(kept.insideClip).toBe(true);
    expect(kept.insidePlate).toBe(true);
    expect(kept.text).toBe(held.text);
    const widths = await host.page.evaluate(() => ({
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
  } finally {
    await closeStages(stages);
  }
});

test('a bumping genre name stays inside its plate and the stage clip at the bump peak', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const stages = await Promise.all([
    newStage(browser, {
      nickname: 'Alice',
      locale: 'en-US',
      viewport: { width: 360, height: 740 },
    }),
    newStage(browser, { nickname: 'Bruno' }),
    newStage(browser, { nickname: 'Cleo' }),
  ]);
  try {
    const [host, ...rest] = stages;
    await assembleRoom(host, rest);
    // 16 characters: the widest name that still bumps (data-long switches
    // the repeating bump off above 16).
    const widest = 'W'.repeat(16);
    const widestM = 'M'.repeat(16);
    await setSettings(host.page, {
      genre: {
        mode: 'custom',
        items: [
          { id: 'short-w', de: widest, en: widest },
          { id: 'short-m', de: widestM, en: widestM },
        ],
      },
    });
    for (const stage of stages) {
      await unlockSound(stage.page);
    }
    await host.page.getByTestId('start-game').click();
    await waitForPhase(host.page, 'GENRE_SPIN');
    await expect(
      host.page.getByTestId('genre-spin').getByTestId('genre-plate'),
    ).toBeVisible({ timeout: 6000 });
    const held = await plateFits(host.page, 'genre-spin');
    expect([widest, widestM]).toContain(held.text);
    expect(held.bumps).toBe(1);
    // The pixel font's line box overhangs 4px at 52px type, so the name's own
    // scrollHeight is not asserted here: no line may leave the plate (peak).
    expect(held.insidePlate).toBe(true);
    expect(held.plateFits).toBe(true);
    expect(held.plateFitsWidth).toBe(true);
    expect(held.insideClip).toBe(true);
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
    await waitForSubmissionMedia(host.page, brunoId, DUPLICATE, 10);

    // Cleo submits the same video later at a different start (20s).
    await ensureConsent(cleo.page);
    await startPlayingPreview(cleo.page, watchUrl(DUPLICATE));
    for (let index = 0; index < 4; index += 1) {
      await cleo.page.getByTestId('start-plus-5').click();
    }
    await expect(cleo.page.getByTestId('start-seconds')).toHaveValue('20');
    await waitForSubmissionMedia(host.page, cleoId, DUPLICATE, 20);

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
      const status = stage.page.getByTestId('preview-status');
      await expect(status).toHaveAttribute('data-state', 'error', {
        timeout: 15000,
      });
      await expect(status).toHaveAttribute('data-error-code', code);
      await expect(stage.page.getByTestId('preview-error')).toBeVisible();
      const state = await stateOf(host.page);
      expect(state?.round?.submissions?.[playerId]).toBeUndefined();
    }

    // Consent gate: nothing external may load before the consent is granted.
    const dario = stages[3];
    const external = dario.youtubeRequests;
    await dario.page.getByTestId('song-link').fill(watchUrl(VALID_D));
    await expect(
      dario.page.getByTestId('submission-consent-required'),
    ).toBeVisible();
    // Past the auto-preview delay: still no player and no YouTube request.
    await dario.page.waitForTimeout(1500);
    expect(external()).toEqual([]);
    await expect(
      dario.page.getByTestId('preview-host').locator('iframe'),
    ).toHaveCount(0);
    await expect(dario.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );

    await ensureConsent(dario.page);
    // Granting the consent starts nothing; the next edit starts the preview.
    await dario.page.getByTestId('song-link').fill('');
    await dario.page.getByTestId('song-link').fill(watchUrl(VALID_D));
    const status = dario.page.getByTestId('preview-status');
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
    const darioId = (await snapshot(dario.page)).clientId;
    await waitForSubmissionMedia(host.page, darioId, VALID_D, 199);
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
    const status = alice.page.getByTestId('preview-status');
    // Replace the link once the slow stale preview is loading, before its
    // error can arrive.
    await expect(status).not.toHaveAttribute('data-state', 'idle', {
      timeout: 15000,
    });
    await alice.page.getByTestId('song-link').fill(watchUrl(STALE_B));
    await expect(status).toHaveAttribute('data-state', 'playing', {
      timeout: 15000,
    });

    // Past the stale error deadline the replacement preview must stay valid.
    await alice.page.waitForTimeout(1800);
    await expect(status).toHaveAttribute('data-state', 'playing');
    await expect(status).not.toHaveAttribute('data-error-code', /./);
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
    await expect(bruno.page.getByTestId('submission-saved')).toBeVisible();

    await host.page.getByTestId('host-pause').click();
    await expect(bruno.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    await expect(
      bruno.page.locator('[data-testid="preview-host"] iframe'),
    ).toHaveCount(0);
    await host.page.getByTestId('host-resume').click();
    await expect(bruno.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    // The same link text fires no edit, so clear the field first.
    await bruno.page.getByTestId('song-link').fill('');
    await startPlayingPreview(bruno.page, watchUrl(VALID_B));
    await expect(bruno.page.getByTestId('submission-saved')).toBeVisible();

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
    // A stale tab cannot change the host's copy: VALID_A is rejected and the
    // autosaved VALID_B stays.
    const stale = await dispatch(bruno.page, {
      type: 'SUBMIT_SONG',
      media: mediaFrom(VALID_A),
    });
    expect(stale.status).toBe('rejected');
    const brunoId = (await snapshot(replacement)).clientId;
    expect(
      (await stateOf(host.page))?.round?.submissions?.[brunoId]?.media.videoId,
    ).toBe(VALID_B);
    // The stored consent carries over, only the one-tap sound gate remains.
    await unlockSound(replacement);
    await submitSongViaUi(replacement, watchUrl(VALID_A));
    await waitForSubmissionMedia(host.page, brunoId, VALID_A);
  } finally {
    await closeStages(stages);
  }
});

/** Three players in SUBMISSION; the first one hosts. */
async function openSubmissionRoom(
  browser: Browser,
  videos: YouTubeFixtureMap = {},
): Promise<Stage[]> {
  const stages = await Promise.all(
    ['Alice', 'Bruno', 'Cleo'].map((nickname) =>
      newStage(browser, { nickname, videos }),
    ),
  );
  const [host, ...rest] = stages;
  await assembleRoom(host, rest);
  await enterSubmission(stages.map((stage) => stage.page));
  return stages;
}

test('a pasted link previews and plays by itself within 2.5 seconds', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const alice = stages[0];
    await ensureConsent(alice.page);
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'idle',
    );
    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    // No click anywhere: the debounce, the load and the play all run alone.
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'playing',
      { timeout: 2500 },
    );
    await expect(alice.page.getByTestId('submission-saved')).toBeVisible();
  } finally {
    await closeStages(stages);
  }
});

test('Fertig right after the paste submits the link before the preview loads', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser, {
    [VALID_A]: { holdReady: true },
  });
  try {
    const [alice, bruno, cleo] = stages;
    const aliceId = (await snapshot(alice.page)).clientId;
    await ensureConsent(alice.page);

    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await alice.page.getByTestId('finish-submission').click();
    // Premise, held by the fixture instead of the wall clock: the fixture
    // withholds `onReady` until the release below, so the click provably
    // precedes the preview load however slow the runner is.
    await expectPreviewNotLoaded(alice.page, VALID_A);
    await releaseFixtureVideo(alice.page, VALID_A);

    await expect
      .poll(
        async () => {
          const round = (await stateOf(alice.page))?.round;
          return {
            done: round?.submissionDoneIds.includes(aliceId) ?? false,
            videoId: round?.submissions?.[aliceId]?.media.videoId ?? null,
          };
        },
        // The held premise adds the release, so give the click's validation,
        // save and finish an explicit budget instead of the 5 s default.
        { timeout: 15000 },
      )
      .toEqual({ done: true, videoId: VALID_A });
    const hostRound = (await stateOf(stages[0].page))?.round;
    expect(hostRound?.submissionDoneIds).toContain(aliceId);
    expect(hostRound?.submissions?.[aliceId]?.media.videoId).toBe(VALID_A);
    await expect(alice.page.getByTestId('submission-finished')).toBeVisible();

    // The others sit this round out; the phase ends once everybody is done.
    await bruno.page.getByTestId('finish-submission').click();
    await cleo.page.getByTestId('finish-submission').click();
    await waitForPhase(alice.page, 'PLAYBACK', 30000);
    await waitForPhase(bruno.page, 'PLAYBACK', 30000);
    const state = await stateOf(alice.page);
    expect(state?.round?.playbackOrder).toEqual([VALID_A]);
    expect(state?.round?.songs.map((song) => song.media.videoId)).toEqual([
      VALID_A,
    ]);
    // Another client can rate the song; its owner sees "your song".
    await expect(bruno.page.getByTestId('rating-bar')).toBeVisible();
    await expect(alice.page.getByTestId('rating-own')).toBeVisible();
  } finally {
    await closeStages(stages);
  }
});

test('two quick links load only the second preview', async ({ browser }) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const alice = stages[0];
    await ensureConsent(alice.page);
    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await alice.page.waitForTimeout(300);
    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_B));
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'playing',
      { timeout: 5000 },
    );
    // The id-less playback prewarm player also reports ready; only previews
    // that carry a video count.
    const loaded = new Set(
      (await youTubeCalls(alice.page))
        .filter((call) => call.type === 'ready' && call.videoId)
        .map((call) => call.videoId),
    );
    expect(loaded).toEqual(new Set([VALID_B]));
    expect(
      alice.youtubeRequests().filter((url) => url.includes(VALID_A)),
    ).toEqual([]);
    const aliceId = (await snapshot(alice.page)).clientId;
    await waitForSubmissionMedia(stages[0].page, aliceId, VALID_B);
  } finally {
    await closeStages(stages);
  }
});

test('Fertig with an embed-blocked link shows the error and does not finish', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser, {
    [BLOCKED_150]: { error: 150 },
  });
  try {
    const alice = stages[0];
    const aliceId = (await snapshot(alice.page)).clientId;
    await ensureConsent(alice.page);
    await alice.page.getByTestId('song-link').fill(watchUrl(BLOCKED_150));
    await alice.page.getByTestId('finish-submission').click();

    await expect(alice.page.getByTestId('preview-error')).toBeVisible({
      timeout: 15000,
    });
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-error-code',
      '150',
    );
    // Busy ends with the failure: the player can fix the link and retry.
    await expect(alice.page.getByTestId('finish-submission')).toBeEnabled();
    await expect(alice.page.getByTestId('song-link')).toBeEnabled();
    await alice.page.waitForTimeout(500);
    const round = (await stateOf(stages[0].page))?.round;
    expect(round?.submissionDoneIds).not.toContain(aliceId);
    expect(round?.submissions?.[aliceId]).toBeUndefined();
    await expect(alice.page.getByTestId('submission-finished')).toHaveCount(0);
    await expect(
      stages[0].page.getByTestId('submission-progress'),
    ).toHaveAttribute('data-count', '0');
  } finally {
    await closeStages(stages);
  }
});

test('an autosaved link still counts when the phase ends without Fertig', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const [host, bruno] = stages;
    const brunoId = (await snapshot(bruno.page)).clientId;
    await ensureConsent(bruno.page);
    await bruno.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await expect(bruno.page.getByTestId('submission-saved')).toBeVisible({
      timeout: 15000,
    });
    // Bruno never presses Fertig; the phase ends early (host advance, as at
    // the deadline) and his song is still in the round.
    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'PLAYBACK', 30000);
    const state = await stateOf(host.page);
    expect(state?.round?.submissionDoneIds).not.toContain(brunoId);
    expect(state?.round?.playbackOrder).toEqual([VALID_A]);
    expect(state?.round?.songs[0]?.ownerIds).toEqual([brunoId]);
  } finally {
    await closeStages(stages);
  }
});

test('the save and load buttons are gone and an empty field explains Fertig', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const alice = stages[0];
    await ensureConsent(alice.page);
    await expect(alice.page.getByTestId('save-submission')).toHaveCount(0);
    await expect(alice.page.getByTestId('load-preview')).toHaveCount(0);
    await expect(alice.page.getByTestId('preview-play')).toHaveCount(0);
    await expect(
      alice.page.getByTestId('submission-finish-hint'),
    ).toBeVisible();
    await expect(alice.page.getByTestId('finish-submission')).toBeEnabled();

    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'playing',
      { timeout: 5000 },
    );
    await expect(alice.page.getByTestId('save-submission')).toHaveCount(0);
    await expect(alice.page.getByTestId('load-preview')).toHaveCount(0);
    await expect(alice.page.getByTestId('preview-play')).toHaveCount(0);
    await expect(alice.page.getByTestId('submission-finish-hint')).toHaveCount(
      0,
    );
  } finally {
    await closeStages(stages);
  }
});

test('a blocked autoplay offers the play button and Fertig plays inside its click', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser, {
    [VALID_A]: { autoplayBlocked: true },
    [VALID_B]: { autoplayBlocked: true, holdReady: true },
  });
  try {
    const [alice, bruno] = stages;
    const aliceId = (await snapshot(alice.page)).clientId;
    const brunoId = (await snapshot(bruno.page)).clientId;

    // The fallback button starts the preview, which then saves by itself.
    await ensureConsent(alice.page);
    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'autoplayBlocked',
      { timeout: 15000 },
    );
    await alice.page.getByTestId('preview-play').click();
    await expect(alice.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'playing',
      { timeout: 15000 },
    );
    await expect(alice.page.getByTestId('preview-play')).toHaveCount(0);
    await waitForSubmissionMedia(stages[0].page, aliceId, VALID_A);

    // Fertig before the preview loads: the blocked autoplay stops it with a
    // hint, the second click plays inside the gesture and finishes. The held
    // load makes that premise deterministic (see the paste test above).
    await ensureConsent(bruno.page);
    await bruno.page.getByTestId('song-link').fill(watchUrl(VALID_B));
    await bruno.page.getByTestId('finish-submission').click();
    await expectPreviewNotLoaded(bruno.page, VALID_B);
    await releaseFixtureVideo(bruno.page, VALID_B);
    await expect(bruno.page.getByTestId('submission-notice')).toBeVisible({
      timeout: 20000,
    });
    await expect(bruno.page.getByTestId('preview-status')).toHaveAttribute(
      'data-state',
      'autoplayBlocked',
    );
    expect(
      (await stateOf(stages[0].page))?.round?.submissionDoneIds,
    ).not.toContain(brunoId);
    await bruno.page.getByTestId('finish-submission').click();
    await expect
      .poll(async () =>
        (await stateOf(stages[0].page))?.round?.submissionDoneIds.includes(
          brunoId,
        ),
      )
      .toBe(true);
    await waitForSubmissionMedia(stages[0].page, brunoId, VALID_B);
  } finally {
    await closeStages(stages);
  }
});

interface DispatchProbe {
  __actions?: string[];
  __releaseSave?: () => void;
}

test('revoking the consent ends a Fertig that waits for the autosave', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const alice = stages[0];
    const aliceId = (await snapshot(alice.page)).clientId;
    await ensureConsent(alice.page);
    // Hold the first SUBMIT_SONG (the autosave at start 0) before it is sent.
    await alice.page.evaluate(() => {
      const probe = window as unknown as DispatchProbe;
      const session = window.__banger!.session;
      const original = session.dispatch.bind(session);
      const gate = new Promise<void>((resolve) => {
        probe.__releaseSave = resolve;
      });
      let held = false;
      session.dispatch = async (action) => {
        if (action.type === 'SUBMIT_SONG' && !held) {
          held = true;
          await gate;
        }
        return original(action);
      };
    });
    await startPlayingPreview(alice.page, watchUrl(VALID_A));
    await alice.page.getByTestId('start-plus-5').click();
    await expect(alice.page.getByTestId('start-seconds')).toHaveValue('5');
    await alice.page.getByTestId('finish-submission').click();
    await expect(alice.page.getByTestId('finish-submission')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    await alice.page.getByTestId('consent-revoke').click();
    await expect(alice.page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'false',
    );
    const requestsAtRevoke = alice.youtubeRequests().length;
    await alice.page.evaluate(() =>
      (window as unknown as DispatchProbe).__releaseSave?.(),
    );

    // The released save may land (it was sent before the revocation), but the
    // finish is over: no new YouTube request, no new preview, not finished.
    await expect(alice.page.getByTestId('finish-submission')).toBeEnabled();
    await alice.page.waitForTimeout(1500);
    expect(alice.youtubeRequests()).toHaveLength(requestsAtRevoke);
    await expect(
      alice.page.getByTestId('preview-host').locator('iframe'),
    ).toHaveCount(0);
    const round = (await stateOf(stages[0].page))?.round;
    expect(round?.submissionDoneIds).not.toContain(aliceId);
    expect(round?.submissions?.[aliceId]?.media.startSeconds).not.toBe(5);
    await expect(alice.page.getByTestId('submission-finished')).toHaveCount(0);
  } finally {
    await closeStages(stages);
  }
});

test('a rejected submit during Fertig is not retried and does not finish', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser, {
    [VALID_A]: { holdReady: true },
  });
  try {
    const alice = stages[0];
    const aliceId = (await snapshot(alice.page)).clientId;
    await ensureConsent(alice.page);
    // The first SUBMIT_SONG fails; every dispatched action type is recorded.
    await alice.page.evaluate(() => {
      const probe = window as unknown as DispatchProbe;
      probe.__actions = [];
      const session = window.__banger!.session;
      const original = session.dispatch.bind(session);
      let failed = false;
      session.dispatch = (action) => {
        probe.__actions?.push(action.type);
        if (action.type === 'SUBMIT_SONG' && !failed) {
          failed = true;
          return Promise.resolve({
            status: 'rejected',
            reason: 'CONNECTION_FAILED',
          });
        }
        return original(action);
      };
    });
    const actions = () =>
      alice.page.evaluate(
        () => (window as unknown as DispatchProbe).__actions ?? [],
      );

    await alice.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await alice.page.getByTestId('finish-submission').click();
    // Held premise (see the paste test above): the click, and with it the
    // only SUBMIT_SONG of this attempt, precedes the preview load. Without
    // the hold a slow runner lets the auto-preview play and autosave first,
    // which makes the click a second, legitimately retried attempt.
    await expectPreviewNotLoaded(alice.page, VALID_A);
    await releaseFixtureVideo(alice.page, VALID_A);
    await expect(alice.page.getByTestId('submission-notice')).toHaveText(
      'Connection failed. Please try again.',
      { timeout: 15000 },
    );
    await expect(alice.page.getByTestId('finish-submission')).toBeEnabled();
    await alice.page.waitForTimeout(500);
    // One submit for this click, no silent second one, no finish.
    expect(await actions()).toEqual(['SUBMIT_SONG']);
    const round = (await stateOf(stages[0].page))?.round;
    expect(round?.submissionDoneIds).not.toContain(aliceId);
    await expect(alice.page.getByTestId('submission-finished')).toHaveCount(0);

    // A new click is a new attempt: it submits again and finishes.
    await alice.page.getByTestId('finish-submission').click();
    await expect(alice.page.getByTestId('submission-finished')).toBeVisible({
      timeout: 15000,
    });
    expect(await actions()).toEqual([
      'SUBMIT_SONG',
      'SUBMIT_SONG',
      'FINISH_SUBMISSION',
    ]);
    await waitForSubmissionMedia(stages[0].page, aliceId, VALID_A);
  } finally {
    await closeStages(stages);
  }
});

test('a Fertig dropped by a pause tells the player to press it again and keeps the draft', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser, {
    [VALID_A]: { holdReady: true },
  });
  try {
    const [host, bruno] = stages;
    const brunoId = (await snapshot(bruno.page)).clientId;
    await ensureConsent(bruno.page);
    await bruno.page.evaluate(() => {
      const probe = window as unknown as DispatchProbe;
      probe.__actions = [];
      const session = window.__banger!.session;
      const original = session.dispatch.bind(session);
      session.dispatch = (action) => {
        probe.__actions?.push(action.type);
        return original(action);
      };
    });
    const actions = () =>
      bruno.page.evaluate(
        () => (window as unknown as DispatchProbe).__actions ?? [],
      );

    await bruno.page.getByTestId('song-link').fill(watchUrl(VALID_A));
    await bruno.page.getByTestId('finish-submission').click();
    // The held load keeps the Fertig waiting for the preview to validate.
    await expectPreviewNotLoaded(bruno.page, VALID_A);
    await expect(bruno.page.getByTestId('finish-submission')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    await host.page.getByTestId('host-pause').click();
    await expect(bruno.page.getByTestId('submission-notice')).toHaveText(
      'The connection dropped briefly. Please press “Done” again.',
    );
    await expect(bruno.page.getByTestId('song-link')).toHaveValue(
      watchUrl(VALID_A),
    );
    await expect(bruno.page.getByTestId('submission-finished')).toHaveCount(0);
    expect((await stateOf(host.page))?.round?.submissionDoneIds).not.toContain(
      brunoId,
    );
    // No automatic retry: the click sent nothing, and nothing follows it.
    await bruno.page.waitForTimeout(500);
    expect(await actions()).toEqual([]);

    await host.page.getByTestId('host-resume').click();
    await expect(bruno.page.getByTestId('finish-submission')).toBeEnabled();
    await expect(bruno.page.getByTestId('song-link')).toHaveValue(
      watchUrl(VALID_A),
    );
    await releaseFixtureVideo(bruno.page, VALID_A);
    await bruno.page.getByTestId('finish-submission').click();
    await expect(bruno.page.getByTestId('submission-finished')).toBeVisible({
      timeout: 15000,
    });
    await waitForSubmissionMedia(host.page, brunoId, VALID_A);
    await expect
      .poll(async () =>
        (await stateOf(host.page))?.round?.submissionDoneIds.includes(brunoId),
      )
      .toBe(true);
  } finally {
    await closeStages(stages);
  }
});

test('a pause after the consent was revoked does not turn the cancelled Fertig into a connection notice', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await openSubmissionRoom(browser);
  try {
    const [host, bruno] = stages;
    const brunoId = (await snapshot(bruno.page)).clientId;
    await ensureConsent(bruno.page);
    // Hold the first SUBMIT_SONG (the autosave at start 0) and record every action.
    await bruno.page.evaluate(() => {
      const probe = window as unknown as DispatchProbe;
      probe.__actions = [];
      const session = window.__banger!.session;
      const original = session.dispatch.bind(session);
      const gate = new Promise<void>((resolve) => {
        probe.__releaseSave = resolve;
      });
      let held = false;
      session.dispatch = async (action) => {
        probe.__actions?.push(action.type);
        if (action.type === 'SUBMIT_SONG' && !held) {
          held = true;
          await gate;
        }
        return original(action);
      };
    });
    const actions = () =>
      bruno.page.evaluate(
        () => (window as unknown as DispatchProbe).__actions ?? [],
      );
    await startPlayingPreview(bruno.page, watchUrl(VALID_A));
    await bruno.page.getByTestId('start-plus-5').click();
    await expect(bruno.page.getByTestId('start-seconds')).toHaveValue('5');
    await bruno.page.getByTestId('finish-submission').click();
    await expect(bruno.page.getByTestId('finish-submission')).toHaveAttribute(
      'aria-busy',
      'true',
    );

    // The consent revocation cancels the click first; the pause comes later.
    await bruno.page.getByTestId('consent-revoke').click();
    await expect(bruno.page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'false',
    );
    await host.page.getByTestId('host-pause').click();
    await expect(bruno.page.getByTestId('pause-banner')).toBeVisible();
    await host.page.getByTestId('host-resume').click();
    await expect(bruno.page.getByTestId('pause-banner')).toHaveCount(0);
    await bruno.page.evaluate(() =>
      (window as unknown as DispatchProbe).__releaseSave?.(),
    );

    await expect(bruno.page.getByTestId('finish-submission')).toBeEnabled();
    await bruno.page.waitForTimeout(1000);
    await expect(
      bruno.page.getByTestId('submission-consent-required'),
    ).toBeVisible();
    await expect(bruno.page.getByTestId('submission-notice')).toHaveCount(0);
    await expect(bruno.page.getByTestId('submission-finished')).toHaveCount(0);
    expect(await actions()).not.toContain('FINISH_SUBMISSION');
    expect(await actions()).toEqual(['SUBMIT_SONG']);
    expect((await stateOf(host.page))?.round?.submissionDoneIds).not.toContain(
      brunoId,
    );
    await expect(bruno.page.getByTestId('start-seconds')).toHaveValue('5');
  } finally {
    await closeStages(stages);
  }
});
