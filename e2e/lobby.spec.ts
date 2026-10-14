import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { ClientAction } from '../src/shared/actions';
import type { CommandResult } from '../src/net/errors';
import type { SessionSnapshot } from '../src/net/session';
import type { GameState } from '../src/shared/game';
import { finishVoting, mediaFor, playToVoting } from './m5-support';

/**
 * End-to-end M2 lobby and realtime scenarios. Every test drives the real UI,
 * the real `GameSession` and the real engine; the only test-only piece is the
 * WebSocket bridge in `e2e/bridge.ts`, which runs the actual in-memory hub as
 * the server-side transport authority. No live Supabase and no credentials.
 */

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

async function openHarness(context: BrowserContext, path = '/'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(path);
  await page.waitForFunction(() => window.__banger !== undefined);
  return page;
}

async function snapshot(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(() => window.__banger!.snapshot());
}

async function stateOf(page: Page): Promise<GameState | null> {
  return (await snapshot(page)).state;
}

async function dispatch(
  page: Page,
  action: ClientAction,
): Promise<CommandResult> {
  return page.evaluate((payload) => window.__banger!.dispatch(payload), action);
}

async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.getByTestId('create-nickname').fill(nickname);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-view')).toBeVisible();
  const code = (await page.getByTestId('room-code').innerText()).trim();
  expect(code).toMatch(CODE_PATTERN);
  return code;
}

/** Joins through the visible form (home or deep-link form). */
async function joinRoom(
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

/** Joins through the real session API (used only to assemble full rooms). */
async function joinViaSession(
  page: Page,
  code: string,
  nickname: string,
): Promise<void> {
  await page.evaluate(
    ({ roomCode, name }) => window.__banger!.session.joinRoom(roomCode, name),
    { roomCode: code, name: nickname },
  );
}

async function waitForPhase(page: Page, phase: string): Promise<void> {
  await expect
    .poll(async () => (await stateOf(page))?.phase.type, { timeout: 15000 })
    .toBe(phase);
}

async function waitForActivePlayers(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await stateOf(page);
        return state
          ? Object.values(state.players).filter(
              (player) =>
                player.connected &&
                player.status !== 'left' &&
                player.status !== 'kicked',
            ).length
          : 0;
      },
      { timeout: 20000 },
    )
    .toBe(count);
}

async function unlockSound(page: Page): Promise<void> {
  await page.getByTestId('sound-consent').click();
  await expect(page.getByTestId('sound-status')).toHaveAttribute(
    'data-unlocked',
    'true',
  );
}

test('three contexts create, join by code and deep link with host-only rules', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const hostContext = await browser.newContext({ locale: 'de-DE' });
  const codeContext = await browser.newContext({ locale: 'en-US' });
  const linkContext = await browser.newContext({ locale: 'en-US' });
  const errors: string[] = [];
  try {
    const host = await openHarness(hostContext, '/');
    host.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    host.on('pageerror', (error) => errors.push(error.message));
    const code = await createRoom(host, 'Alice');

    const byCode = await openHarness(codeContext, '/');
    await joinRoom(byCode, code, 'Bob');

    const byLink = await openHarness(linkContext, `/r/${code}`);
    await joinRoom(byLink, code, 'Cara');

    // All three tabs converge on the same room and roster.
    for (const page of [host, byCode, byLink]) {
      await expect(page.getByTestId('room-code')).toHaveText(code);
      await expect(page.getByTestId('roster-row')).toHaveCount(3);
    }
    await expect(
      host.locator('[data-testid="roster-row"][data-host="true"]'),
    ).toHaveCount(1);
    await expect(
      byCode.locator('[data-testid="roster-row"][data-self="true"]'),
    ).toHaveText(/Bob/);

    // Settings are host-only: the host may edit, the others may not.
    await expect(host.getByTestId('settings-rounds')).toBeEnabled();
    await expect(byCode.getByTestId('settings-rounds')).toBeDisabled();
    await expect(byCode.getByTestId('settings-save')).toBeDisabled();

    // Readiness reacts to the real sound unlock action.
    await expect(host.getByTestId('lobby-readiness')).toHaveAttribute(
      'data-ready',
      'false',
    );
    await host.getByTestId('sound-consent').click();
    await expect(host.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );
    await unlockSound(byCode);
    await unlockSound(byLink);
    await expect(host.getByTestId('lobby-readiness')).toHaveAttribute(
      'data-ready',
      'true',
    );

    expect(errors).toEqual([]);
  } finally {
    await Promise.all([
      hostContext.close(),
      codeContext.close(),
      linkContext.close(),
    ]);
  }
});

test('the genre-fail penalty switches off to 0 and back on to -3', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const memberContext = await browser.newContext({ locale: 'en-US' });
  try {
    const host = await openHarness(hostContext);
    const code = await createRoom(host, 'Host');
    const member = await openHarness(memberContext);
    await joinRoom(member, code, 'Member');

    const penaltyOf = async () =>
      (await stateOf(host))?.settings.genreFailPenalty;
    const save = async () => {
      await host.getByTestId('settings-save').click();
      await expect(host.getByTestId('settings-status')).toHaveAttribute(
        'data-state',
        'saved',
      );
    };

    // Both controls carry the genre-fail context and the help text that
    // explains their meaning to assistive tech (SPEC §6).
    const toggle = host.getByRole('checkbox', {
      name: 'Genre-fail penalty Penalty active',
    });
    const penalty = host.getByRole('spinbutton', {
      name: 'Genre-fail penalty',
    });
    await expect(toggle).toBeChecked();
    await expect(penalty).toBeEnabled();
    await expect(penalty).toHaveValue('-3');
    await expect(toggle).toHaveAccessibleDescription('−1 to −10 points.');
    await expect(penalty).toHaveAccessibleDescription('−1 to −10 points.');

    // Switched off: the number input is disabled and 0 is saved.
    await toggle.uncheck();
    await expect(penalty).toBeDisabled();
    await expect(host.getByTestId('settings-genre-fail-off')).toHaveText('Off');
    await expect(toggle).toHaveAccessibleDescription('Off');
    await expect(penalty).toHaveAccessibleDescription('Off');
    await save();
    await expect.poll(penaltyOf).toBe(0);

    // Everyone else reads the localized "off" instead of a bare 0.
    await expect(member.getByTestId('settings-genre-fail-off')).toHaveText(
      'Off',
    );
    const memberToggle = member.getByRole('checkbox', {
      name: 'Genre-fail penalty Penalty active',
    });
    const memberPenalty = member.getByRole('spinbutton', {
      name: 'Genre-fail penalty',
    });
    await expect(memberToggle).toBeDisabled();
    await expect(memberToggle).toHaveAccessibleDescription('Off');
    await expect(memberPenalty).toBeDisabled();
    await expect(memberPenalty).toHaveAccessibleDescription('Off');

    // Switched on again: -3 is restored and saved unchanged.
    await toggle.check();
    await expect(penalty).toBeEnabled();
    await expect(penalty).toHaveValue('-3');
    await expect(host.getByTestId('settings-genre-fail-off')).toHaveCount(0);
    await save();
    await expect.poll(penaltyOf).toBe(-3);
    await expect(member.getByTestId('settings-genre-fail-penalty')).toHaveValue(
      '-3',
    );

    // And the input still accepts a value from the documented -1..-10 range.
    await penalty.fill('-7');
    await save();
    await expect.poll(penaltyOf).toBe(-7);
  } finally {
    await Promise.all([hostContext.close(), memberContext.close()]);
  }
});

test('a late join after START_GAME becomes a spectator', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const secondContext = await browser.newContext({ locale: 'en-US' });
  const thirdContext = await browser.newContext({ locale: 'en-US' });
  const lateContext = await browser.newContext({ locale: 'en-US' });
  try {
    const host = await openHarness(hostContext);
    const code = await createRoom(host, 'Host');
    const second = await openHarness(secondContext);
    await joinRoom(second, code, 'Second');
    const third = await openHarness(thirdContext);
    await joinRoom(third, code, 'Third');

    const settings = (await stateOf(host))!.settings;
    expect(
      (
        await dispatch(host, {
          type: 'SET_SETTINGS',
          settings: {
            ...settings,
            genre: {
              mode: 'fixed',
              genre: { id: 'rap-de', de: 'Deutscher Rap', en: 'German Rap' },
            },
          },
        })
      ).status,
    ).toBe('accepted');

    await unlockSound(host);
    await unlockSound(second);
    await unlockSound(third);
    // The permanent start hint is part of the LOBBY, not of a running game.
    await expect(host.getByTestId('lobby-start-hint')).toBeVisible();
    expect((await dispatch(host, { type: 'START_GAME' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host, 'GENRE_SPIN');
    await expect(host.getByTestId('lobby-start-hint')).toHaveCount(0);

    const late = await openHarness(lateContext, `/r/${code}`);
    await joinRoom(late, code, 'Late');

    await expect(late.getByTestId('spectator-notice')).toBeVisible();
    await expect(
      late.locator('[data-testid="roster-row"][data-self="true"]'),
    ).toHaveAttribute('data-status', 'spectator');
    await expect(late.getByTestId('phase-genre')).toContainText('German Rap');
    await late.getByTestId('language-switch').selectOption('de');
    await expect(late.getByTestId('phase-genre')).toContainText(
      'Deutscher Rap',
    );
    // Existing players stay participants.
    await expect(
      host.locator('[data-testid="roster-row"][data-self="true"]'),
    ).toHaveAttribute('data-participant', 'true');
  } finally {
    await Promise.all([
      hostContext.close(),
      secondContext.close(),
      thirdContext.close(),
      lateContext.close(),
    ]);
  }
});

test('a host second tab rebinds identity: old tab read-only, new tab writes', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const memberContext = await browser.newContext({ locale: 'en-US' });
  try {
    const firstTab = await openHarness(hostContext);
    const code = await createRoom(firstTab, 'Alice');
    const member = await openHarness(memberContext);
    await joinRoom(member, code, 'Bob');

    // Same browser context => same retained clientId, new connectionId.
    const secondTab = await openHarness(hostContext, `/r/${code}`);
    await expect(secondTab.getByTestId('room-view')).toBeVisible();

    const firstIdentity = await snapshot(firstTab);
    const secondIdentity = await snapshot(secondTab);
    expect(secondIdentity.clientId).toBe(firstIdentity.clientId);
    expect(secondIdentity.connectionId).not.toBe(firstIdentity.connectionId);

    // The newest tab holds the write connection; the old host tab is read-only.
    await expect(firstTab.getByTestId('read-only-indicator')).toBeVisible();
    await expect(firstTab.getByTestId('settings-rounds')).toBeDisabled();
    await expect(firstTab.locator('[data-testid="kick-player"]')).toHaveCount(
      0,
    );

    await expect(secondTab.getByTestId('read-only-indicator')).toHaveCount(0);
    await expect(secondTab.getByTestId('settings-rounds')).toBeEnabled();
    await expect(secondTab.locator('[data-testid="kick-player"]')).toHaveCount(
      1,
    );
    await expect(secondTab.getByTestId('roster-row')).toHaveCount(2);

    // Same identity means the same room and the same (empty) score.
    const firstState = await stateOf(firstTab);
    const secondState = await stateOf(secondTab);
    const aliceId = firstIdentity.clientId;
    expect(secondState?.players[aliceId]?.totalScore).toBe(
      firstState?.players[aliceId]?.totalScore,
    );
    expect(secondState?.roomCode).toBe(code);

    // An ordinary member's second tab takes the write connection the same way.
    const memberSecond = await openHarness(memberContext, `/r/${code}`);
    await expect(memberSecond.getByTestId('room-view')).toBeVisible();
    await expect(member.getByTestId('read-only-indicator')).toBeVisible();
    await expect(memberSecond.getByTestId('read-only-indicator')).toHaveCount(
      0,
    );
    await expect(memberSecond.getByTestId('sound-consent')).toBeEnabled();
    // Members never gain host powers, only the write connection.
    await expect(memberSecond.getByTestId('settings-rounds')).toBeDisabled();
  } finally {
    await Promise.all([hostContext.close(), memberContext.close()]);
  }
});

test('invalid, missing, duplicate and full-room joins stay consumer visible', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const dupContext = await browser.newContext({ locale: 'en-US' });
  const invalidContext = await browser.newContext({ locale: 'en-US' });
  const joiners = await Promise.all(
    Array.from({ length: 9 }, () => browser.newContext({ locale: 'en-US' })),
  );
  const overflowContext = await browser.newContext({ locale: 'en-US' });
  const allContexts = [
    hostContext,
    dupContext,
    invalidContext,
    ...joiners,
    overflowContext,
  ];
  try {
    const host = await openHarness(hostContext);
    const code = await createRoom(host, 'Host');

    // Invalid code is rejected client-side.
    const invalid = await openHarness(invalidContext);
    await invalid.getByTestId('join-code').fill('ABC');
    await invalid.getByTestId('join-nickname').fill('Nope');
    await invalid.getByTestId('join-room').click();
    await expect(invalid.getByTestId('home-error')).toBeVisible();

    // Unknown room surfaces ROOM_NOT_FOUND.
    const missing = await openHarness(dupContext);
    await missing.getByTestId('join-code').fill('ZZZZZZ');
    await missing.getByTestId('join-nickname').fill('Ghost');
    await missing.getByTestId('join-room').click();
    // A genuinely missing room is reported after the automatic retry's second
    // discovery window, so give the error more than the default 5 s.
    await expect(
      missing
        .getByTestId('home-error')
        .or(missing.getByTestId('session-error')),
    ).toBeVisible({ timeout: 20000 });

    // Duplicate nickname is refused.
    const duplicate = await openHarness(dupContext);
    await duplicate.getByTestId('join-code').fill(code);
    await duplicate.getByTestId('join-nickname').fill('Host');
    await duplicate.getByTestId('join-room').click();
    await expect(
      duplicate
        .getByTestId('home-error')
        .or(duplicate.getByTestId('session-error')),
    ).toBeVisible();

    // Fill the room to capacity through the real session API.
    await Promise.all(
      joiners.map(async (context, index) => {
        const page = await openHarness(context);
        await joinViaSession(page, code, `Player${index}`);
        await expect(page.getByTestId('room-view')).toBeVisible({
          timeout: 20000,
        });
      }),
    );
    await waitForActivePlayers(host, 10);

    // The eleventh connection is refused with ROOM_FULL.
    const overflow = await openHarness(overflowContext);
    await overflow.getByTestId('join-code').fill(code);
    await overflow.getByTestId('join-nickname').fill('Eleventh');
    await overflow.getByTestId('join-room').click();
    await expect(
      overflow
        .getByTestId('home-error')
        .or(overflow.getByTestId('session-error')),
    ).toBeVisible();
    // Form cleanup clears the transient transport error; membership is the
    // consumer contract, not the lifetime of that internal status field.
    await expect(overflow.getByTestId('room-view')).not.toBeVisible();
    await expect(host.getByTestId('roster-row')).toHaveCount(10);
  } finally {
    await Promise.all(allContexts.map((context) => context.close()));
  }
});

test('reload keeps the retained identity and score without game persistence', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const memberContext = await browser.newContext({ locale: 'en-US' });
  const thirdContext = await browser.newContext({ locale: 'en-US' });
  try {
    const host = await openHarness(hostContext);
    const code = await createRoom(host, 'Host');
    const member = await openHarness(memberContext);
    await joinRoom(member, code, 'Member');
    const third = await openHarness(thirdContext);
    await joinRoom(third, code, 'Third');

    const players = [host, member, third];
    const medias = await playToVoting(players, 1);
    await finishVoting(players, medias);
    await waitForPhase(host, 'REVEAL');

    const memberId = (await snapshot(member)).clientId;
    const before = await stateOf(host);
    expect(before?.results).toHaveLength(1);
    const scoreBefore = before?.players[memberId]?.totalScore ?? 0;
    expect(scoreBefore).toBe(3);

    // Only the identity is stored locally, never the game.
    const storageKeys = await member.evaluate(() => Object.keys(localStorage));
    expect(storageKeys).toEqual(['banger-roulette.clientId']);

    await member.reload();
    await expect(member.getByTestId('room-view')).toBeVisible({
      timeout: 20000,
    });

    const after = await snapshot(member);
    expect(after.clientId).toBe(memberId);
    expect(after.state?.players[memberId]?.totalScore).toBe(scoreBefore);
    expect(after.state?.roomCode).toBe(code);
    // Reload retained points, not the previous document's audio permission.
    await expect(member.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'false',
    );
    await expect
      .poll(async () => (await stateOf(host))?.players[memberId]?.soundUnlocked)
      .toBe(false);
    await unlockSound(member);
  } finally {
    await Promise.all([
      hostContext.close(),
      memberContext.close(),
      thirdContext.close(),
    ]);
  }
});

test('host disconnect during voting migrates and keeps every round datum', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const hostContext = await browser.newContext({ locale: 'en-US' });
  const memberContext = await browser.newContext({ locale: 'en-US' });
  const thirdContext = await browser.newContext({ locale: 'en-US' });
  try {
    const host = await openHarness(hostContext);
    const code = await createRoom(host, 'Host');
    const member = await openHarness(memberContext);
    await joinRoom(member, code, 'Member');
    const third = await openHarness(thirdContext);
    await joinRoom(third, code, 'Third');

    const players = [host, member, third];
    const firstMedias = await playToVoting(players, 1);
    await finishVoting(players, firstMedias);
    await waitForPhase(host, 'REVEAL');

    // Round two: reach VOTING, then leave drafts and flags unsubmitted.
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
    await waitForPhase(host, 'GENRE_SPIN');
    expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe('accepted');
    await waitForPhase(host, 'SUBMISSION');
    const secondMedias = players.map((_, index) => mediaFor(2, index));
    for (const [index, player] of players.entries()) {
      expect(
        (
          await dispatch(player, {
            type: 'SUBMIT_SONG',
            media: secondMedias[index],
          })
        ).status,
      ).toBe('accepted');
      expect(
        (await dispatch(player, { type: 'FINISH_SUBMISSION' })).status,
      ).toBe('accepted');
    }
    await waitForPhase(host, 'PLAYBACK');
    for (let index = 0; index < secondMedias.length; index += 1) {
      expect((await dispatch(host, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host, 'VOTING');

    const memberId = (await snapshot(member)).clientId;
    const draft = secondMedias
      .filter((media) => media.videoId !== secondMedias[1].videoId)
      .map((media) => media.videoId);
    expect(
      (await dispatch(member, { type: 'SET_RANKING', ranking: draft })).status,
    ).toBe('accepted');
    const flagged = secondMedias[0].videoId;
    expect(
      (
        await dispatch(member, {
          type: 'SET_GENRE_FAIL',
          videoId: flagged,
          flagged: true,
        })
      ).status,
    ).toBe('accepted');

    const before = await stateOf(host);
    const oldHostId = before?.hostId ?? '';
    const scoreBefore = before?.players[memberId]?.totalScore ?? 0;
    expect(before?.results).toHaveLength(1);
    expect(before?.round?.number).toBe(2);
    expect(before?.round?.songs).toHaveLength(3);

    // Hard host loss: closing the page drops its socket and presence.
    await host.close();
    const started = Date.now();
    await expect
      .poll(async () => (await stateOf(member))?.hostId, {
        timeout: 5000,
        intervals: [50, 100, 200],
      })
      .not.toBe(oldHostId);
    const elapsed = Date.now() - started;
    // In-memory measurement only; it makes no claim about Supabase timing.
    expect(elapsed).toBeLessThan(5000);

    await expect
      .poll(
        async () => {
          const state = await stateOf(member);
          return (
            state !== null &&
            state.hostId !== oldHostId &&
            state.results.length === 1 &&
            state.round?.number === 2
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);

    const after = await stateOf(member);
    expect(after?.hostId).not.toBe(oldHostId);
    expect(after?.results).toHaveLength(1);
    expect(after?.players[memberId]?.totalScore).toBe(scoreBefore);
    expect(after?.round).toEqual(before?.round);
    expect(after?.results).toEqual(before?.results);
    expect(after?.phase).toEqual(before?.phase);
    expect(after?.round?.ballots[memberId]?.ranking).toEqual(draft);
    expect(after?.round?.genreFailFlags[memberId]).toContain(flagged);
  } finally {
    await Promise.all([
      hostContext.close(),
      memberContext.close(),
      thirdContext.close(),
    ]);
  }
});

test('copy link falls back to manual sharing when the clipboard is denied', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript(() => {
    // Simulates a browser that refuses programmatic clipboard writes.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error('clipboard denied')),
      },
    });
  });
  try {
    const page = await openHarness(context);
    const code = await createRoom(page, 'Sharer');
    await page.getByTestId('copy-link').click();
    const fallback = page.getByTestId('copy-link-fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveValue(
      `${await page.evaluate(() => window.location.origin)}/r/${code}`,
    );
    await fallback.focus();
    await expect(fallback).toBeFocused();
  } finally {
    await context.close();
  }
});

test('room view stays within 360px and switches language without reload', async ({
  browser,
}) => {
  const context = await browser.newContext({
    locale: 'de-DE',
    viewport: { width: 360, height: 640 },
  });
  try {
    const page = await openHarness(context);
    await createRoom(page, 'Mobile');

    const widths = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(widths.documentScrollWidth).toBeLessThanOrEqual(widths.innerWidth);
    expect(widths.bodyScrollWidth).toBeLessThanOrEqual(widths.innerWidth);

    const select = page.getByTestId('language-switch');
    await expect(select).toHaveValue('de');
    await expect(page.getByTestId('lobby-start-hint')).toHaveText(
      'Der Host startet die Runde, sobald 3–10 Spieler bereit sind (Sound aktiviert).',
    );
    const token = await page.evaluate(() => {
      const value = 'room-token';
      (window as unknown as Record<string, unknown>).__roomToken = value;
      return value;
    });
    await select.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('lobby-start-hint')).toHaveText(
      'The host starts the round once 3–10 players are ready (sound enabled).',
    );
    const tokenAfter = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__roomToken,
    );
    expect(tokenAfter).toBe(token);
    await expect(page.getByTestId('room-view')).toBeVisible();
  } finally {
    await context.close();
  }
});
