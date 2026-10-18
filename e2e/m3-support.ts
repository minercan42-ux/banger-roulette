import { expect } from '@playwright/test';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from '@playwright/test';
import type { ClientAction } from '../src/shared/actions';
import type { CommandResult } from '../src/net/errors';
import type { SessionSnapshot } from '../src/net/session';
import type { GameState } from '../src/shared/game';
import type { Settings } from '../src/shared/settings';
import { NO_AUDIO_DEVICE } from './silent-audio';
import {
  installYouTubeFixture,
  watchYouTubeRequests,
  youTubeCalls,
  type YouTubeFixtureMap,
} from './youtube-fixture';

/**
 * Shared Playwright wiring for the M3 submission suite. Every stage is a real
 * browser context driving the real UI, the real `GameSession` over the WS
 * bridge and the real engine; only the external YouTube edge is replaced by
 * `youtube-fixture.ts`.
 */
export interface Stage {
  readonly nickname: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly youtubeRequests: () => string[];
}

export interface StageOptions {
  nickname: string;
  videos?: YouTubeFixtureMap;
  locale?: string;
  reducedMotion?: 'reduce' | 'no-preference';
  viewport?: { width: number; height: number };
  /**
   * Simulated client wall-clock skew in milliseconds. The page's `Date.now`
   * is shifted by this amount while `/api/time` still reports real server
   * time, so the session must compensate through its clock sync (FR-31).
   */
  wallClockOffsetMs?: number;
}

/**
 * A browser context of the test harness. It carries the mode the engine needs:
 * the Firefox project selects the test-only silent sink here, before any page
 * script runs, and every other engine keeps its native `AudioContext`
 * (see `e2e/silent-audio.ts`). A spec that creates its context directly has to
 * go through this factory, or the FR-07 consent click of that engine never
 * settles.
 *
 * Firefox also gets `window.event` pinned to `undefined`. The app never reads
 * that legacy property; React's dev-mode update timer does
 * (`resolveEventTimeStamp`) and Firefox can hand a protocol-driven script an
 * event object whose `timeStamp` it may not read, so the store notification
 * after a command throws `Permission denied to access property "timeStamp"`.
 * That rejects the driving `evaluate` (the lobby migration spec, #140) and can
 * lose the re-render behind an input-driven command. The pinned value makes the
 * instrumentation take its `performance.now()` branch, exactly like the
 * production build, which ships no such code. Clicks and every other app path
 * are unaffected (verified in #140).
 */
export async function harnessContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  if (browser.browserType().name() === 'firefox') {
    await context.addInitScript((mode) => {
      window.__silentAudioMode = mode;
    }, NO_AUDIO_DEVICE);
    await context.addInitScript(() => {
      window.event = undefined;
    });
  }
  return context;
}

export async function newStage(
  browser: Browser,
  options: StageOptions,
): Promise<Stage> {
  const context = await harnessContext(browser, {
    locale: options.locale ?? 'en-US',
    reducedMotion: options.reducedMotion,
    viewport: options.viewport,
  });
  await installYouTubeFixture(context, options.videos ?? {});
  const skew = options.wallClockOffsetMs ?? 0;
  if (skew !== 0) {
    await context.addInitScript((offset) => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + offset;
    }, skew);
  }
  const page = await context.newPage();
  const youtubeRequests = watchYouTubeRequests(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__banger !== undefined);
  return { nickname: options.nickname, context, page, youtubeRequests };
}

export async function closeStages(stages: readonly Stage[]): Promise<void> {
  await Promise.all(stages.map((stage) => stage.context.close()));
}

export function snapshot(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(() => window.__banger!.snapshot());
}

export async function stateOf(page: Page): Promise<GameState | null> {
  return (await snapshot(page)).state;
}

export function dispatch(
  page: Page,
  action: ClientAction,
): Promise<CommandResult> {
  return page.evaluate((payload) => window.__banger!.dispatch(payload), action);
}

export async function createRoom(
  page: Page,
  nickname: string,
): Promise<string> {
  await page.getByTestId('create-nickname').fill(nickname);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-view')).toBeVisible();
  const code = (await page.getByTestId('room-code').innerText()).trim();
  expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  return code;
}

export async function joinRoom(
  page: Page,
  code: string,
  nickname: string,
): Promise<void> {
  await expect(
    page.getByTestId('route-join-view').or(page.getByTestId('home-forms')),
  ).toBeVisible();
  await page.getByTestId('join-code').fill(code);
  await page.getByTestId('join-nickname').fill(nickname);
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('room-view')).toBeVisible();
}

/**
 * The start gate's one click ("Los geht's", or "Tippen zum Starten" once the
 * consent is stored): grants the YouTube consent and unlocks audio.
 */
export async function unlockSound(page: Page): Promise<void> {
  const accept = page.getByTestId('start-gate-accept');
  const unlocked = page.locator(
    '[data-testid="sound-status"][data-unlocked="true"]',
  );
  // Idempotent: a page that already passed the gate has nothing to click.
  await expect(accept.or(unlocked).first()).toBeAttached();
  if ((await accept.count()) > 0) {
    await accept.click();
  }
  await expect(page.getByTestId('start-gate')).toHaveCount(0);
  await expect(page.getByTestId('sound-status')).toHaveAttribute(
    'data-unlocked',
    'true',
  );
}

/** "Ohne Videos": unlocks audio but grants no YouTube consent. */
export async function unlockSoundWithoutVideos(page: Page): Promise<void> {
  const decline = page.getByTestId('start-gate-decline');
  const unlocked = page.locator(
    '[data-testid="sound-status"][data-unlocked="true"]',
  );
  await expect(decline.or(unlocked).first()).toBeAttached();
  if ((await decline.count()) > 0) {
    await decline.click();
  }
  await expect(page.getByTestId('start-gate')).toHaveCount(0);
  await expect(page.getByTestId('sound-status')).toHaveAttribute(
    'data-unlocked',
    'true',
  );
}

export async function waitForPhase(
  page: Page,
  phase: string,
  timeoutMs = 20000,
): Promise<void> {
  await expect
    .poll(async () => (await stateOf(page))?.phase.type, { timeout: timeoutMs })
    .toBe(phase);
}

/** Assembles a room through the visible forms: first stage hosts, rest join. */
export async function assembleRoom(
  host: Stage,
  joiners: readonly Stage[],
): Promise<string> {
  const code = await createRoom(host.page, host.nickname);
  for (const joiner of joiners) {
    await joinRoom(joiner.page, code, joiner.nickname);
  }
  return code;
}

export async function setSettings(
  page: Page,
  patch: Partial<Settings>,
): Promise<void> {
  const state = await stateOf(page);
  if (state === null) {
    throw new Error('Cannot patch settings without a room state');
  }
  const result = await dispatch(page, {
    type: 'SET_SETTINGS',
    settings: { ...state.settings, ...patch },
  });
  expect(result.status).toBe('accepted');
}

/** Unlocks sound everywhere, starts the game and lands on the SUBMISSION phase. */
export async function enterSubmission(
  players: Page[],
  options: { withoutVideos?: readonly Page[] } = {},
): Promise<void> {
  const [host, ...others] = players;
  for (const player of players) {
    if (options.withoutVideos?.includes(player)) {
      await unlockSoundWithoutVideos(player);
    } else {
      await unlockSound(player);
    }
  }
  await host.getByTestId('start-game').click();
  await waitForPhase(host, 'SUBMISSION');
  await Promise.all(others.map((player) => waitForPhase(player, 'SUBMISSION')));
}

/** Makes sure the YouTube consent is granted (the drawer offers it after "Ohne Videos"). */
export async function ensureConsent(page: Page): Promise<void> {
  const grant = page.getByTestId('consent-grant');
  if ((await grant.count()) > 0) {
    await grant.click();
  }
  await expect(page.getByTestId('consent-status')).toHaveAttribute(
    'data-consented',
    'true',
  );
}

/**
 * Pastes a link and proves the automatic preview reaches PLAYING without any
 * further click (the preview starts about a second after the last edit).
 */
export async function startPlayingPreview(
  page: Page,
  url: string,
): Promise<void> {
  await page.getByTestId('song-link').fill(url);
  await expect(page.getByTestId('preview-status')).toHaveAttribute(
    'data-state',
    'playing',
    { timeout: 15000 },
  );
}

/**
 * Proves a preview whose load the fixture holds (see `holdReady`) has not
 * loaded yet: the panel is still "loading" and no player for that video
 * reported ready. It is the deterministic form of "this action preceded the
 * preview load", which the app's one-second auto-preview debounce otherwise
 * decides by wall clock (too slow a click on a loaded runner and the preview
 * has already played). Only meaningful while a hold is in place; release it
 * with `releaseFixtureVideo` right after.
 */
export async function expectPreviewNotLoaded(
  page: Page,
  videoId: string,
): Promise<void> {
  await expect(page.getByTestId('preview-status')).toHaveAttribute(
    'data-state',
    'loading',
  );
  expect(
    (await youTubeCalls(page)).filter(
      (call) => call.type === 'ready' && call.videoId === videoId,
    ),
  ).toEqual([]);
}

/**
 * Presses "Fertig" with the keyboard (focus, then Enter) in a scenario that
 * pastes a link and acts within the one-second auto-preview debounce. A mouse
 * click is two events, down and up, and on a slow frame clock (headless Firefox
 * on a CI runner needs about 750 ms for them) the debounce can insert the
 * preview between them: the button moves, the up event lands elsewhere and no
 * click happens, so the Fertig the scenario waits for never starts. A key
 * press activates the focused button whatever moves around it.
 */
export async function pressFertig(page: Page): Promise<void> {
  await page.getByTestId('finish-submission').press('Enter');
}

export interface SubmitSongOptions {
  plus5?: number;
  setStart?: boolean;
}

/**
 * Full consumer path: consent, link, validated preview, start. The validated
 * link is saved by itself; this waits until the host holds it at the start
 * shown in the field.
 */
export async function submitSongViaUi(
  page: Page,
  url: string,
  options: SubmitSongOptions = {},
): Promise<void> {
  await ensureConsent(page);
  await startPlayingPreview(page, url);
  if (options.setStart === true) {
    await page.getByTestId('set-start').click();
  }
  for (let index = 0; index < (options.plus5 ?? 0); index += 1) {
    await page.getByTestId('start-plus-5').click();
  }
  const start = Number(await page.getByTestId('start-seconds').inputValue());
  const clientId = (await snapshot(page)).clientId;
  await expect
    .poll(
      async () =>
        (await stateOf(page))?.round?.submissions?.[clientId]?.media
          .startSeconds,
      { timeout: 15000 },
    )
    .toBe(start);
  await expect(page.getByTestId('submission-saved')).toBeVisible();
}
