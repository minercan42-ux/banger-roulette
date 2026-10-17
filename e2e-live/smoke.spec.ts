import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  assertClean,
  installViolationReporter,
  watchPage,
  type WatchedPage,
} from './csp-watch';

/**
 * M7 / issue #20: the committed live smoke suite. It drives the *deployed* app
 * only through the UI (no `window.__banger` harness, no in-memory bridge) and
 * observes AK-1..AK-5 plus the `?debug=1` AK-7 overlay values.
 *
 * Production has no test harness, so every action goes through the real forms
 * and every observation reads a documented `data-testid` (see `src/ui/*`). The
 * UI knowledge is copied from `e2e/m3-support.ts` and `e2e/m5-game.spec.ts`;
 * their helpers cannot be imported because they need `window.__banger`.
 *
 * Run with `pnpm test:e2e:live` (see `playwright.live.config.ts`), never as
 * part of the PR `CI` workflow. The production publishable Supabase key is
 * baked into the deployment; this suite needs no secret.
 *
 * Deliberately NO `page.evaluate`/`locator.evaluate`: Playwright's injected
 * `UtilityScript` compiles those callbacks with `globalThis.eval`, which the
 * deployment's `script-src` (no `'unsafe-eval'`) blocks - the resulting
 * `securitypolicyviolation` would masquerade as an app defect. Everything is
 * read through locators and collected through `page.on('console')` instead, so
 * "fail on any securitypolicyviolation" stays strict and meaningful.
 */

const BASE_URL =
  process.env.LIVE_BASE_URL ?? 'https://banger-roulette.vercel.app';
const ORIGIN = new URL(BASE_URL).origin;

/** Official YouTube sample, Big Buck Bunny and "Me at the zoo" - all embeddable. */
const LINKED_ID = 'M7lc1UVf-VE';
const CARA_ID = 'aqz-KE-bpKQ';
const DANA_ID = 'jNQXAC9IVRw';

const HOST_NICK = 'AliceDE';
const BOB_NICK = 'BobEN';
const CARA_NICK = 'CaraDE';
const DANA_NICK = 'DanaEN';

const SUBMISSIONS = {
  host: LINKED_ID,
  bob: LINKED_ID,
  cara: CARA_ID,
  dana: DANA_ID,
} as const;

const NICKNAMES = [HOST_NICK, BOB_NICK, CARA_NICK, DANA_NICK];

interface Player {
  page: Page;
  watcher: WatchedPage;
}

/**
 * Creates one isolated browser context per player, with a locale, and attaches
 * the shared CSP violation collector and console/page-error collector (see
 * `csp-watch.ts`, which the offline regression `e2e/csp/live-csp-collector.spec.ts`
 * exercises as well).
 */
async function newPlayer(
  browser: Browser,
  locale: string,
  label: string,
): Promise<Player> {
  const context = await browser.newContext({
    locale,
    viewport: { width: 1280, height: 800 },
  });
  await installViolationReporter(context);
  const page = await context.newPage();
  return { page, watcher: watchPage(page, label, ORIGIN) };
}

/**
 * Submits a home form and waits for the room view. Issue #15's session-level
 * retry (`createRoom`/`joinRoom` retry the first transient failure once) is what
 * makes the first attempt survive, so the suite deliberately adds no retry of
 * its own: a create/join regression must fail the smoke.
 */
async function enterRoom(
  page: Page,
  buttonTestId: 'create-room' | 'join-room',
): Promise<void> {
  await page.getByTestId(buttonTestId).click();
  await expect(page.getByTestId('room-view')).toBeVisible({ timeout: 40_000 });
}

async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('home-forms')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-nickname').fill(nickname);
  await enterRoom(page, 'create-room');
  const code = (await page.getByTestId('room-code').textContent())?.trim();
  if (!code) {
    throw new Error('host never showed a room code');
  }
  return code;
}

async function joinByCode(
  page: Page,
  code: string,
  nickname: string,
): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('home-forms')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('join-code').fill(code);
  await page.getByTestId('join-nickname').fill(nickname);
  await enterRoom(page, 'join-room');
}

async function joinByLink(
  page: Page,
  code: string,
  nickname: string,
  debug: boolean,
): Promise<void> {
  await page.goto(`/r/${code}${debug ? '?debug=1' : ''}`);
  const nicknameField = page.getByTestId('join-nickname');
  await expect(nicknameField).toBeVisible({ timeout: 40_000 });
  await nicknameField.fill(nickname);
  await enterRoom(page, 'join-room');
  if (!debug) {
    return;
  }
  // A form join makes the Shell `pushState('/r/CODE')`, which drops the query.
  // Loading the debug URL again re-joins the retained identity without
  // navigating, so `?debug=1` survives into the game.
  await page.goto(`/r/${code}?debug=1`);
  await expect(page.getByTestId('room-view')).toBeVisible({ timeout: 40_000 });
}

/**
 * Passes the start gate ("Los geht's", or the one-tap form after a stored
 * consent): grants the YouTube consent, unlocks Web Audio and waits until the
 * server confirms the unlock. A page that already passed has nothing to click.
 */
async function unlockSound(page: Page): Promise<void> {
  const accept = page.getByTestId('start-gate-accept');
  const unlocked = page.locator(
    '[data-testid="sound-status"][data-unlocked="true"]',
  );
  await expect(accept.or(unlocked).first()).toBeAttached({ timeout: 30_000 });
  if ((await accept.count()) > 0) {
    await accept.click();
  }
  await expect(page.getByTestId('sound-status')).toHaveAttribute(
    'data-unlocked',
    'true',
    { timeout: 20_000 },
  );
}

async function applySettings(page: Page): Promise<void> {
  await page.getByTestId('settings-rounds').fill('2');
  await page.getByTestId('settings-submission-seconds').fill('30');
  await page.getByTestId('settings-clip-seconds').fill('15');
  await expect(page.getByTestId('settings-status')).toHaveAttribute(
    'data-state',
    'dirty',
    { timeout: 10_000 },
  );
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status')).toHaveAttribute(
    'data-state',
    'saved',
    { timeout: 20_000 },
  );
}

async function waitPhase(
  page: Page,
  phase: string,
  timeout = 90_000,
): Promise<void> {
  await expect(page.getByTestId('room-view')).toHaveAttribute(
    'data-phase',
    phase,
    { timeout },
  );
}

interface GenreSnapshot {
  id: string | null;
  angle: string | null;
}

async function captureGenre(page: Page): Promise<GenreSnapshot> {
  const wheel = page.getByTestId('genre-wheel');
  await expect(wheel).toBeVisible({ timeout: 30_000 });
  return {
    id: await wheel.getAttribute('data-genre-id'),
    angle: await wheel.getAttribute('data-target-angle'),
  };
}

/**
 * Full submission path: link, automatic preview, autosave, done (FR-20..FR-26);
 * the consent came from the start gate. A browser that blocks the autoplay
 * shows the play button, which this clicks as the user would.
 */
async function submitSong(page: Page, videoId: string): Promise<void> {
  const link = page.getByTestId('song-link');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.fill(`https://www.youtube.com/watch?v=${videoId}`);
  const status = page.getByTestId('preview-status');
  const play = page.getByTestId('preview-play');
  await expect
    .poll(
      async () => {
        if (await play.isVisible()) {
          await play.click();
        }
        return status.getAttribute('data-state');
      },
      { timeout: 60_000 },
    )
    .toBe('playing');
  await expect(page.getByTestId('submission-saved')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('finish-submission').click();
  // The last finisher advances the round, which unmounts the panel before the
  // "finished" marker can be observed; accept the phase change as success too.
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByTestId('submission-finished')
            .isVisible()
            .catch(() => false)
        ) {
          return 'done';
        }
        const phase = await page
          .getByTestId('room-view')
          .getAttribute('data-phase')
          .catch(() => null);
        return phase === 'SUBMISSION' ? 'wait' : 'left';
      },
      { timeout: 30_000 },
    )
    .not.toBe('wait');
}

/** AK-3: no owner nickname may be visible in the rating section before REVEAL. */
async function assertNoOwnerLeak(page: Page): Promise<void> {
  const text =
    (await page
      .getByTestId('rating-section')
      .textContent({ timeout: 2_000 })
      .catch(() => '')) ?? '';
  for (const nickname of NICKNAMES) {
    expect(text, `nickname ${nickname} leaked before REVEAL`).not.toContain(
      nickname,
    );
  }
}

interface RatingSummary {
  /** Songs rated through the chip bar. */
  rated: number;
  /** Songs that showed "your song" instead of a bar. */
  own: number;
  /** Whether the genre-fail chip (rating-chip-0) was ever enabled on an owned song. */
  ownGenreFailEnabled: boolean;
}

/**
 * Plays PLAYBACK like a player (FR-40): taps the same chip for every song that
 * is not theirs while it plays, notes the songs that show "your song" instead,
 * and returns once the phase ends. A paused game keeps the chips disabled, so
 * the loop simply waits for the host to resume.
 */
async function ratePlaying(page: Page, value = 8): Promise<RatingSummary> {
  const seen = new Set<string>();
  const summary: RatingSummary = {
    rated: 0,
    own: 0,
    ownGenreFailEnabled: false,
  };
  const room = page.getByTestId('room-view');
  for (;;) {
    const phase = await room
      .getAttribute('data-phase', { timeout: 5_000 })
      .catch(() => null);
    if (phase !== 'PLAYBACK') {
      return summary;
    }
    const index = await page
      .getByTestId('playback-phase')
      .getAttribute('data-index', { timeout: 1_000 })
      .catch(() => null);
    if (index !== null && !seen.has(index)) {
      const chip = page.getByTestId(`rating-chip-${value}`);
      if (
        await page
          .getByTestId('rating-own')
          .isVisible()
          .catch(() => false)
      ) {
        seen.add(index);
        summary.own += 1;
        if (
          await page
            .getByTestId('rating-chip-0')
            .isEnabled()
            .catch(() => false)
        ) {
          summary.ownGenreFailEnabled = true;
        }
        await assertNoOwnerLeak(page);
      } else if (await chip.isEnabled().catch(() => false)) {
        await chip.click({ timeout: 5_000 }).catch(() => undefined);
        const pressed = await expect(chip)
          .toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (pressed) {
          seen.add(index);
          summary.rated += 1;
          await assertNoOwnerLeak(page);
        }
      }
    }
    await page.waitForTimeout(300);
  }
}

/**
 * Both row types render the total in a `br-lb__pts` cell: the displayed number
 * (`aria-hidden`, "10.0") next to its `sr-only` label ("10.0 Punkte"). Scanning
 * the row's spans for the label matched that cell's wrapper as well, whose
 * textContent concatenates both numbers ("10.010.0 Punkte" -> 10.01); reading
 * the cell's `aria-hidden` number takes exactly one formatted score per row.
 */
async function readScores(
  page: Page,
  testId: 'leaderboard-row' | 'final-standing-row',
): Promise<Map<string, number>> {
  const rows = page.locator(`[data-testid="${testId}"]`);
  const count = await rows.count();
  const scores = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const id = (await row.getAttribute('data-player-id')) ?? '';
    const scoreText = await row
      .locator('.br-lb__pts [aria-hidden="true"]')
      .first()
      .innerText();
    const match = scoreText.match(/-?\d+(?:\.\d+)?/);
    scores.set(id, match ? Number(match[0]) : Number.NaN);
  }
  return scores;
}

/**
 * The round score is the last integer of a reveal entry's label in both
 * locales ("... round score 4" / "... Rundenpunkte 4"), so the trailing number
 * is read without parsing the surrounding copy.
 */
function lastNumber(text: string): number | null {
  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?/g)];
  const last = numbers[numbers.length - 1];
  return last ? Number(last[0]) : null;
}

/**
 * Reads one reveal entry's round score from the UI. That is the points the
 * engine awards *per owner* of the entry (`ownerDeltas`), so it is also the
 * exact share every owner must find in their own leaderboard total.
 */
async function readEntryRoundPoints(
  page: Page,
  videoId: string,
): Promise<number> {
  const entry = page.locator(
    `[data-testid="reveal-entry"][data-video-id="${videoId}"]`,
  );
  await expect(entry).toBeVisible({ timeout: 30_000 });
  const text =
    (await entry.getByTestId('reveal-entry-points').textContent()) ?? '';
  const points = lastNumber(text);
  expect(
    points,
    `reveal entry ${videoId} exposes a round score`,
  ).not.toBeNull();
  return points as number;
}

async function selfPlayerId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-testid="roster-row"][data-self="true"]')
    .first()
    .getAttribute('data-player-id');
  if (!id) {
    throw new Error('self roster row had no player id');
  }
  return id;
}

/** Waits until the host badge sits on a player other than `formerHostId`. */
async function waitForNewHost(
  page: Page,
  formerHostId: string,
  timeoutMs: number,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hostRow = page.locator(
      '[data-testid="roster-row"][data-host="true"]',
    );
    if ((await hostRow.count()) > 0) {
      const id = await hostRow.first().getAttribute('data-player-id');
      if (id !== null && id !== formerHostId) {
        return Date.now() - start;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`host did not migrate within ${timeoutMs} ms`);
}

/**
 * A quorum pause (the reloading client briefly drops the room below three
 * connected players) does not resume on its own; the current host has to click
 * resume. Clicks that button whenever it appears and returns once `cara` can
 * write again, so the wait is bounded by the recovery, not a fixed window.
 */
async function recoverPlayback(
  players: readonly Player[],
  cara: Player,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const player of players) {
      const resume = player.page.getByTestId('host-resume');
      if (await resume.isVisible().catch(() => false)) {
        await resume.click();
      }
    }
    const writable =
      (await cara.page
        .getByTestId('rating-chip-8')
        .isEnabled()
        .catch(() => false)) ||
      (await cara.page
        .getByTestId('rating-own')
        .isVisible()
        .catch(() => false));
    if (writable) {
      return;
    }
    await players[0]!.page.waitForTimeout(300);
  }
  throw new Error('rating did not become writable again after the reload');
}
interface DebugSample {
  index: number;
  startSkew: string | null;
  drift: string | null;
  status: string | null;
}

/**
 * Opportunistically watches for the linked preroll animation (FR-26). It lives
 * in a three-second window, so the result is reported as an annotation rather
 * than asserted; the deterministic proof is the REVEAL entry.
 */
async function observeLinkedAnimation(
  page: Page,
  windowMs: number,
): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if ((await page.getByTestId('linked-animation').count()) > 0) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/** Samples the `?debug=1` overlay while a playback phase runs (AK-7 evidence). */
async function sampleDebugOverlay(
  page: Page,
  samples: DebugSample[],
  stopped: () => boolean,
): Promise<void> {
  const debug = page.getByTestId('playback-debug');
  const counter = page.getByTestId('playback-song-count');
  while (!stopped()) {
    try {
      if ((await debug.count()) > 0) {
        const index = Number(
          (await counter.getAttribute('data-index', { timeout: 500 })) ?? '0',
        );
        samples.push({
          index: Number.isFinite(index) ? index : 0,
          startSkew: await debug.getAttribute('data-start-skew-ms', {
            timeout: 500,
          }),
          drift: await debug.getAttribute('data-drift-ms', { timeout: 500 }),
          status: await debug.getAttribute('data-status', { timeout: 500 }),
        });
      }
    } catch {
      // The overlay unmounts when the phase ends; a skipped sample is fine.
    }
    await page.waitForTimeout(250);
  }
}

/** Records the last observed debug value per song as test annotations (AK-7). */
function annotateDebug(samples: readonly DebugSample[], round: number): void {
  const byIndex = new Map<number, DebugSample>();
  for (const sample of samples) {
    byIndex.set(sample.index, sample);
  }
  for (const [index, sample] of [...byIndex.entries()].sort(
    (left, right) => left[0] - right[0],
  )) {
    const skew =
      sample.startSkew && sample.startSkew !== '' ? sample.startSkew : 'n/a';
    const drift = sample.drift && sample.drift !== '' ? sample.drift : 'n/a';
    test.info().annotations.push({
      type: `ak7-r${round}-song${index + 1}-start-skew-ms`,
      description: skew,
    });
    test.info().annotations.push({
      type: `ak7-r${round}-song${index + 1}-drift-ms`,
      description: drift,
    });
    test.info().annotations.push({
      type: `ak7-r${round}-song${index + 1}-status`,
      description: sample.status ?? 'n/a',
    });
  }
}

test('live smoke: 4-player game on the deployment covers AK-1..AK-5', async ({
  browser,
}) => {
  const startedAt = Date.now();
  const host = await newPlayer(browser, 'de-DE', 'A-host-de');
  const bob = await newPlayer(browser, 'en-US', 'B-en');
  const cara = await newPlayer(browser, 'de-DE', 'C-de');
  const dana = await newPlayer(browser, 'en-US', 'D-debug-en');
  const players = [host, bob, cara, dana];
  const watched = players.map((player) => player.watcher);
  const debugPage = dana.page;

  // --- Lobby: create, join by code and by deep link, sound, settings ---------
  const code = await createRoom(host.page, HOST_NICK);
  test.info().annotations.push({ type: 'room-code', description: code });
  await joinByCode(bob.page, code, BOB_NICK);
  await joinByLink(cara.page, code, CARA_NICK, false);
  await joinByLink(dana.page, code, DANA_NICK, true);

  await expect(host.page.getByTestId('roster-row')).toHaveCount(4, {
    timeout: 30_000,
  });
  await Promise.all(players.map((player) => unlockSound(player.page)));
  await applySettings(host.page);
  await expect(host.page.getByTestId('lobby-readiness')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 30_000 },
  );
  assertClean(watched);

  // --- Round 1 --------------------------------------------------------------
  await host.page.getByTestId('start-game').click();
  const genres = await Promise.all(
    players.map((player) => captureGenre(player.page)),
  );
  const genreId = genres[0]!.id;
  expect(genreId, 'genre wheel exposed no genre id').toBeTruthy();
  for (const snapshot of genres) {
    expect(snapshot.id, 'AK-1: all clients must see the same genre').toBe(
      genreId,
    );
    expect(
      snapshot.angle,
      'AK-1: all clients must animate to the same wheel segment',
    ).toBe(genres[0]!.angle);
  }
  test.info().annotations.push({
    type: 'ak1-genre-id',
    description: genreId ?? '',
  });

  await Promise.all(
    players.map((player) => waitPhase(player.page, 'SUBMISSION')),
  );
  await Promise.all([
    submitSong(host.page, SUBMISSIONS.host),
    submitSong(bob.page, SUBMISSIONS.bob),
    submitSong(cara.page, SUBMISSIONS.cara),
    submitSong(dana.page, SUBMISSIONS.dana),
  ]);

  await waitPhase(host.page, 'PLAYBACK');
  // AK-7 evidence collection starts as early as possible on the debug tab.
  const round1Samples: DebugSample[] = [];
  const round1Sampler = { stopped: false };
  const round1Sampling = sampleDebugOverlay(
    debugPage,
    round1Samples,
    () => round1Sampler.stopped,
  );
  // AK-2's linked preroll animation lives in a three-second window that can
  // close before a lagging client renders it, so it is recorded, never
  // asserted; the deterministic proof of FR-26 is the REVEAL entry below.
  const round1LinkedObservation = observeLinkedAnimation(host.page, 5_000);
  await Promise.all(
    players.map((player) => waitPhase(player.page, 'PLAYBACK')),
  );
  // AK-2: the duplicate video id collapses into one entry (3 songs, 4 players).
  await expect(debugPage.getByTestId('playback-song-count')).toHaveAttribute(
    'data-count',
    '3',
    { timeout: 20_000 },
  );
  // AK-7: the debug overlay exists on the `?debug=1` tab.
  await expect(debugPage.getByTestId('playback-debug')).toBeVisible({
    timeout: 20_000,
  });
  // AK-3 during playback: no owner is shown while anonymity is on.
  await expect(host.page.getByTestId('playback-owner')).toHaveCount(0);
  await expect(host.page.getByTestId('playback-anonymous-note')).toBeVisible();
  test.info().annotations.push({
    type: 'linked-animation-in-playback',
    description: (await round1LinkedObservation) ? 'seen' : 'not-seen',
  });
  // AK-2 and AK-3 while the songs play: every player rates the two songs they
  // do not own (the linked song counts as one song owned by Alice and Bob),
  // sees "your song" instead of a bar for their own, can neither rate nor genre-fail
  // it, and no owner nickname shows up in the rating section.
  const round1Rated = await Promise.all(
    players.map((player) => ratePlaying(player.page)),
  );
  round1Sampler.stopped = true;
  await round1Sampling;
  annotateDebug(round1Samples, 1);
  for (const summary of round1Rated) {
    expect(summary.own, 'AK-2: each player owns exactly one of 3 songs').toBe(
      1,
    );
    expect(summary.rated, 'every foreign song is rated through the bar').toBe(
      2,
    );
    expect(
      summary.ownGenreFailEnabled,
      'AK-2: owners cannot genre-fail their song',
    ).toBe(false);
  }
  await Promise.all(
    players.map((player) => waitPhase(player.page, 'REVEAL', 60_000)),
  );

  // AK-2 at reveal: the linked entry names both owners and scores them.
  const linkedEntry = host.page.locator(
    `[data-testid="reveal-entry"][data-video-id="${LINKED_ID}"]`,
  );
  await expect(linkedEntry).toBeVisible({ timeout: 30_000 });
  const linkedOwners = await linkedEntry
    .getByTestId('reveal-entry-owners')
    .textContent();
  expect(
    linkedOwners,
    'AK-2: both linked owners are named at REVEAL',
  ).toContain(HOST_NICK);
  expect(
    linkedOwners,
    'AK-2: both linked owners are named at REVEAL',
  ).toContain(BOB_NICK);
  await expect(linkedEntry.getByTestId('linked-animation')).toBeVisible();

  await expect(host.page.getByTestId('leaderboard')).toBeVisible({
    timeout: 40_000,
  });
  const round1Scores = await readScores(host.page, 'leaderboard-row');
  expect(round1Scores.size, 'leaderboard lists every player').toBe(4);
  // Alice's id is reused by the AK-4 measurement below, which needs it right
  // before closing her page; the identity never changes, so both read the same
  // roster row.
  const hostId = await selfPlayerId(host.page);
  const bobId = await selfPlayerId(bob.page);
  const caraId = await selfPlayerId(cara.page);
  const round1Cara = round1Scores.get(caraId) ?? 0;
  expect(round1Cara, 'AK-5 baseline: Cara scored in round 1').toBeGreaterThan(
    0,
  );

  // AK-2 continued: naming both owners is not enough, both must be *scored*.
  // The reveal shows the round score the engine awards each owner of the entry
  // (`linkedPoints` defaults to `full`, so it is the unchanged song score), and
  // the linked song is Alice's and Bob's only source of points this round, so
  // their round-1 totals must equal it exactly. A zero share - which the old
  // names-plus-Cara-score check would have passed - fails here.
  const linkedRoundPoints = await readEntryRoundPoints(host.page, LINKED_ID);
  expect(
    linkedRoundPoints,
    'AK-2: a completed linked song must score above zero',
  ).toBeGreaterThan(0);
  expect(
    round1Scores.get(hostId),
    `AK-2: Alice's round-1 total equals her share of ${LINKED_ID}`,
  ).toBe(linkedRoundPoints);
  expect(
    round1Scores.get(bobId),
    `AK-2: Bob's round-1 total equals his share of ${LINKED_ID}`,
  ).toBe(linkedRoundPoints);

  // --- Round 2 --------------------------------------------------------------
  await Promise.all(
    players.map((player) => waitPhase(player.page, 'SUBMISSION', 90_000)),
  );
  await Promise.all([
    submitSong(host.page, SUBMISSIONS.host),
    submitSong(bob.page, SUBMISSIONS.bob),
    submitSong(cara.page, SUBMISSIONS.cara),
    submitSong(dana.page, SUBMISSIONS.dana),
  ]);
  await waitPhase(debugPage, 'PLAYBACK');
  const round2Samples: DebugSample[] = [];
  const round2Sampler = { stopped: false };
  const round2Sampling = sampleDebugOverlay(
    debugPage,
    round2Samples,
    () => round2Sampler.stopped,
  );
  await Promise.all(
    players.map((player) => waitPhase(player.page, 'PLAYBACK')),
  );
  round2Sampler.stopped = true;
  await round2Sampling;
  annotateDebug(round2Samples, 2);

  // AK-4: the host closes the tab during PLAYBACK; another player takes over.
  // `hostId`, captured at the round-1 reveal, is the id that must lose the badge.
  const ak4Start = Date.now();
  await host.page.close();
  const migrationMs = await Promise.all(
    [bob, cara, dana].map((player) =>
      waitForNewHost(player.page, hostId, 5_000),
    ),
  );
  const ak4Ms = Math.max(...migrationMs, Date.now() - ak4Start);
  expect(ak4Ms, 'AK-4: host migration must finish within 5 s').toBeLessThan(
    5_000,
  );
  test.info().annotations.push({
    type: 'ak4-host-migration-ms',
    description: String(ak4Ms),
  });

  // AK-5: Cara reloads and rejoins the running room with an unchanged total.
  const ak5Start = Date.now();
  await cara.page.reload({ waitUntil: 'domcontentloaded' });
  await waitPhase(cara.page, 'PLAYBACK', 15_000);
  const ak5Ms = Date.now() - ak5Start;
  expect(ak5Ms, 'AK-5: rejoin must finish within 5 s').toBeLessThan(5_000);
  test.info().annotations.push({
    type: 'ak5-rejoin-ms',
    description: String(ak5Ms),
  });
  await recoverPlayback([bob, cara, dana], cara);

  await Promise.all(
    [bob, cara, dana].map((player) => ratePlaying(player.page)),
  );
  await Promise.all(
    [bob, cara, dana].map((player) => waitPhase(player.page, 'REVEAL', 60_000)),
  );

  // AK-5 continued: Cara's total after the reload equals round 1 plus round 2.
  const caraRound2 = await readEntryRoundPoints(bob.page, CARA_ID);

  await Promise.all(
    [bob, cara, dana].map((player) => waitPhase(player.page, 'FINAL', 90_000)),
  );

  // FINAL shows consistent scores on every remaining client.
  const finals = await Promise.all(
    [bob, cara, dana].map((player) =>
      readScores(player.page, 'final-standing-row'),
    ),
  );
  const reference = finals[0]!;
  for (const table of finals) {
    expect(
      [...table.entries()].sort(),
      'FINAL standings agree across clients',
    ).toEqual([...reference.entries()].sort());
  }
  const caraFinal = reference.get(caraId) ?? Number.NaN;
  expect(
    caraFinal,
    'AK-5: reload did not lose Cara points (round 1 + round 2)',
  ).toBe(round1Cara + caraRound2);
  // Baselines for the rematch reset check below: all three remaining players
  // scored above zero in this game, so a carried-over total would be larger
  // than the rematch round alone and cannot be mistaken for a reset.
  const danaId = await selfPlayerId(dana.page);
  const bobFinal = reference.get(bobId) ?? Number.NaN;
  const danaFinal = reference.get(danaId) ?? Number.NaN;
  expect(bobFinal, 'Bob scored in the first game').toBeGreaterThan(0);
  expect(danaFinal, 'Dana scored in the first game').toBeGreaterThan(0);

  // Rematch returns to the LOBBY with the settings preserved.
  await expect(bob.page.getByTestId('final-rematch')).toBeVisible({
    timeout: 30_000,
  });
  await bob.page.getByTestId('final-rematch').click();
  for (const player of [bob, cara, dana]) {
    await waitPhase(player.page, 'LOBBY', 30_000);
    await expect(player.page.getByTestId('settings-rounds')).toHaveValue('2');
  }
  assertClean(watched);

  // --- Rematch reset (finding 3) --------------------------------------------
  // LOBBY exposes no score at all: the leaderboard only renders in REVEAL and
  // the roster shows names and badges only. The reset is therefore observable
  // at the rematch's first scoreboard: with round 1 of the new game revealed,
  // every total must equal exactly the points that player's own entry earned
  // in that round - none of the previous game's totals may survive. The new
  // host is Bob (he held `final-rematch`), and Alice stays away, so the game
  // runs with three players and three songs.
  // The reloaded tab lost its audio permission: `useSoundUnlock` re-asserts
  // `unlocked: false` for a retained actor on every page load, so Cara has to
  // pass the one-tap start gate again. Without it the lobby stays "1 player without sound" and the
  // host's start button never enables. Bob and Dana are already unlocked, so
  // their click is skipped by the helper.
  await Promise.all(
    [bob, cara, dana].map((player) => unlockSound(player.page)),
  );
  await expect(bob.page.getByTestId('lobby-readiness')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 30_000 },
  );
  await bob.page.getByTestId('start-game').click();
  await Promise.all(
    [bob, cara, dana].map((player) => waitPhase(player.page, 'SUBMISSION')),
  );
  await Promise.all([
    submitSong(bob.page, SUBMISSIONS.bob),
    submitSong(cara.page, SUBMISSIONS.cara),
    submitSong(dana.page, SUBMISSIONS.dana),
  ]);
  await Promise.all(
    [bob, cara, dana].map((player) =>
      waitPhase(player.page, 'PLAYBACK', 150_000),
    ),
  );
  await Promise.all(
    [bob, cara, dana].map((player) => ratePlaying(player.page)),
  );
  await Promise.all(
    [bob, cara, dana].map((player) => waitPhase(player.page, 'REVEAL', 60_000)),
  );
  await expect(bob.page.getByTestId('leaderboard')).toBeVisible({
    timeout: 60_000,
  });
  const rematchScores = await readScores(bob.page, 'leaderboard-row');
  const rematchOwners = [
    { label: 'Bob', playerId: bobId, videoId: LINKED_ID, previous: bobFinal },
    { label: 'Cara', playerId: caraId, videoId: CARA_ID, previous: caraFinal },
    { label: 'Dana', playerId: danaId, videoId: DANA_ID, previous: danaFinal },
  ];
  const rematchTotals: string[] = [];
  for (const owner of rematchOwners) {
    const roundPoints = await readEntryRoundPoints(bob.page, owner.videoId);
    expect(
      roundPoints,
      `rematch: ${owner.label}'s entry scores above zero`,
    ).toBeGreaterThan(0);
    const total = rematchScores.get(owner.playerId) ?? Number.NaN;
    expect(
      total,
      `rematch reset: ${owner.label}'s total is only the new round's points` +
        ` (previous game: ${owner.previous})`,
    ).toBe(roundPoints);
    rematchTotals.push(`${owner.label}=${total}`);
  }
  test.info().annotations.push({
    type: 'rematch-reset-totals',
    description: rematchTotals.join(', '),
  });
  assertClean(watched);

  const runtimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  test.info().annotations.push({
    type: 'runtime-seconds',
    description: String(runtimeSeconds),
  });
  console.log(
    `live smoke: runtime ${runtimeSeconds}s, AK-4 ${ak4Ms}ms, AK-5 ${ak5Ms}ms`,
  );
});
