import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '../src/shared/game';
import {
  assembleRoom,
  closeStages,
  dispatch,
  joinRoom,
  newStage,
  setSettings,
  snapshot,
  stateOf,
  unlockSound,
  waitForPhase,
  type Stage,
} from './m3-support';
import { mediaFor } from './m5-support';

/**
 * SPEC §6 accessibility coverage: the phase live region and a keyboard-only run.
 *
 * The announcement is a polite region mounted for the whole room lifecycle
 * (LOBBY included), so it announces every observed phase change including the
 * lobby boundary, yet stays silent on its first mount (entering, a reload or a
 * reconnect is not a transition). The keyboard scenario drives one real player
 * from creating the room through the Finale purely with Tab/Shift+Tab/Enter/
 * Space for that player's own interactions, proving the native controls are
 * actually reachable instead of merely clickable.
 */

/** Upper bound on Tab presses while searching for a control; generous but finite. */
const MAX_TABS = 200;

interface FocusInfo {
  testId: string | null;
  videoId: string | null;
}

async function focusedInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const item = active?.closest(
      '[data-testid="voting-rank-item"]',
    ) as HTMLElement | null;
    return {
      testId: active?.getAttribute('data-testid') ?? null,
      videoId: item?.getAttribute('data-video-id') ?? null,
    };
  });
}

/**
 * Moves focus to a control using only the Tab key. Returns early when the
 * control already holds focus (React keeps the node across reorders), so a
 * caller never overshoots the target.
 */
async function tabTo(
  page: Page,
  target: { testId: string; videoId?: string },
): Promise<void> {
  for (let presses = 0; presses <= MAX_TABS; presses += 1) {
    const info = await focusedInfo(page);
    if (
      info.testId === target.testId &&
      (target.videoId === undefined || info.videoId === target.videoId)
    ) {
      return;
    }
    if (presses === MAX_TABS) {
      break;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Keyboard pass could not reach ${JSON.stringify(target)} within ${MAX_TABS} Tab presses`,
  );
}

/** Submits one song through the visible form with keyboard input only. */
async function submitSongByKeyboard(page: Page, url: string): Promise<void> {
  await tabTo(page, { testId: 'song-link' });
  await page.keyboard.type(url);
  await expect(page.getByTestId('song-link')).toHaveValue(url);

  await tabTo(page, { testId: 'youtube-consent' });
  await page.keyboard.press(' ');
  await expect(page.getByTestId('youtube-consent')).toBeChecked();

  await tabTo(page, { testId: 'load-preview' });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('preview-status')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 15_000 },
  );

  await tabTo(page, { testId: 'preview-play' });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('preview-status')).toHaveAttribute(
    'data-state',
    'playing',
    { timeout: 15_000 },
  );

  await tabTo(page, { testId: 'save-submission' });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('submission-saved')).toBeVisible();

  await tabTo(page, { testId: 'finish-submission' });
  await page.keyboard.press('Enter');
}

async function rankOf(page: Page, videoId: string): Promise<number> {
  const item = page.locator(
    `[data-testid="voting-rank-item"][data-video-id="${videoId}"]`,
  );
  return Number(await item.getAttribute('data-rank'));
}

/** Moves a ranked song to `targetRank` using only the up/down buttons. */
async function moveByKeyboard(
  page: Page,
  videoId: string,
  targetRank: number,
): Promise<void> {
  for (let guard = 0; guard < 12; guard += 1) {
    const rank = await rankOf(page, videoId);
    if (rank === targetRank) {
      return;
    }
    const testId = rank > targetRank ? 'voting-rank-up' : 'voting-rank-down';
    await tabTo(page, { testId, videoId });
    await page.keyboard.press('Enter');
    await expect
      .poll(() => rankOf(page, videoId), { timeout: 5000 })
      .toBe(rank + (rank > targetRank ? -1 : 1));
  }
  throw new Error(
    `Could not move ${videoId} to rank ${targetRank} by keyboard`,
  );
}

/** Adds every foreign song to the ranking with the keyboard only. */
async function rankAllByKeyboard(page: Page, expected: number): Promise<void> {
  for (let index = 0; index < expected; index += 1) {
    await tabTo(page, { testId: 'voting-song-add' });
    await page.keyboard.press('Enter');
  }
  await expect(page.getByTestId('voting-rank-item')).toHaveCount(expected);
}

async function ballotOf(page: Page, id: string): Promise<string[]> {
  const state = await stateOf(page);
  return state?.round?.ballots?.[id]?.ranking ?? [];
}

/** Ranks every foreign song and finishes voting through the session. */
async function finishVotingFor(
  page: Page,
  state: GameState | null,
): Promise<void> {
  const id = (await snapshot(page)).clientId;
  const ranking = (state?.round?.songs ?? [])
    .filter((song) => !song.ownerIds.includes(id))
    .map((song) => song.media.videoId);
  expect((await dispatch(page, { type: 'SET_RANKING', ranking })).status).toBe(
    'accepted',
  );
  expect((await dispatch(page, { type: 'FINISH_VOTING' })).status).toBe(
    'accepted',
  );
  await expect
    .poll(async () => (await stateOf(page))?.round?.votingDoneIds ?? [])
    .toContain(id);
}

test('announces every phase transition including the lobby boundary but stays silent on mount', async ({
  browser,
}) => {
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host, bob] = stages as [Stage, Stage, Stage];
    const all = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await setSettings(host.page, { rounds: 1 });

    // The region is mounted in the lobby but must not announce its own mount.
    await expect(host.page.getByTestId('phase-announcement')).toHaveText('');

    for (const page of all) {
      await unlockSound(page);
    }
    await host.page.getByTestId('start-game').click();

    // The lobby boundary itself is announced when the game starts.
    await waitForPhase(host.page, 'GENRE_SPIN');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Genre roulette, round 1 of 1.',
    );

    await waitForPhase(host.page, 'SUBMISSION');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Song submission, round 1 of 1.',
    );
    // Every client owns its own live region, so a second player hears it too.
    await expect(bob.page.getByTestId('phase-announcement')).toHaveText(
      'Song submission, round 1 of 1.',
    );

    for (const [index, page] of all.entries()) {
      const media = mediaFor(1, index);
      expect(
        (await dispatch(page, { type: 'SUBMIT_SONG', media })).status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_SUBMISSION' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'PLAYBACK');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Playback, round 1 of 1.',
    );

    const songCount = (await stateOf(host.page))?.round?.songs.length ?? 0;
    for (let index = 0; index < songCount; index += 1) {
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'VOTING');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Voting, round 1 of 1.',
    );

    const state = await stateOf(host.page);
    for (const page of all) {
      await finishVotingFor(page, state);
    }
    await waitForPhase(host.page, 'REVEAL');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Reveal, round 1 of 1.',
    );

    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'FINAL');
    await expect(host.page.getByTestId('phase-announcement')).toContainText(
      'Finale',
    );

    // Rematch leaves FINAL, so the return to the lobby is announced here too.
    await host.page.getByTestId('final-rematch').click();
    await waitForPhase(host.page, 'LOBBY');
    await expect(host.page.getByTestId('phase-announcement')).toHaveText(
      'Lobby.',
    );
  } finally {
    await closeStages(stages);
  }
});

test('stays silent when a running room is reloaded, then announces later transitions', async ({
  browser,
}) => {
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host, bob, cara] = stages as [Stage, Stage, Stage];
    const all = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await setSettings(host.page, { rounds: 1 });
    for (const page of all) {
      await unlockSound(page);
    }
    await host.page.getByTestId('start-game').click();
    await waitForPhase(host.page, 'SUBMISSION');
    await Promise.all(all.map((page) => waitForPhase(page, 'SUBMISSION')));

    // Host and Bob submit; Cara is still pending, so the phase stays SUBMISSION.
    for (const [index, page] of [host.page, bob.page].entries()) {
      const media = mediaFor(1, index);
      expect(
        (await dispatch(page, { type: 'SUBMIT_SONG', media })).status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_SUBMISSION' })).status).toBe(
        'accepted',
      );
    }

    // Reloading a running room remounts the region: it must stay quiet.
    await bob.page.reload();
    await expect(bob.page.getByTestId('room-view')).toBeVisible();
    await waitForPhase(bob.page, 'SUBMISSION');
    await expect(bob.page.getByTestId('phase-announcement')).toHaveText('');

    // The transient disconnect may trip the quorum pause; the host resumes.
    if ((await stateOf(host.page))?.pause) {
      expect(
        (
          await dispatch(host.page, {
            type: 'RESUME',
            forceBelowMinimum: false,
          })
        ).status,
      ).toBe('accepted');
    }

    // Cara's submission resolves the round; the reloaded region still announces.
    expect(
      (
        await dispatch(cara.page, {
          type: 'SUBMIT_SONG',
          media: mediaFor(1, 2),
        })
      ).status,
    ).toBe('accepted');
    expect(
      (await dispatch(cara.page, { type: 'FINISH_SUBMISSION' })).status,
    ).toBe('accepted');
    await waitForPhase(bob.page, 'PLAYBACK');
    await expect(bob.page.getByTestId('phase-announcement')).toHaveText(
      'Playback, round 1 of 1.',
    );
  } finally {
    await closeStages(stages);
  }
});

test('one player completes the round from Lobby to Finale with the keyboard only', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await Promise.all([
    newStage(browser, { nickname: 'Alice' }),
    newStage(browser, { nickname: 'Bob' }),
    newStage(browser, { nickname: 'Cara' }),
  ]);
  try {
    const [host, ...others] = stages as [Stage, Stage, Stage];
    const all = stages.map((stage) => stage.page);

    // The audited player creates and joins the room by keyboard.
    await tabTo(host.page, { testId: 'create-nickname' });
    await host.page.keyboard.type('Alice');
    await tabTo(host.page, { testId: 'create-room' });
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByTestId('room-view')).toBeVisible();
    const code = (await host.page.getByTestId('room-code').innerText()).trim();

    // The other players are session fixtures and may use the visible forms.
    for (const stage of others) {
      await joinRoom(stage.page, code, stage.nickname);
    }
    await setSettings(host.page, { rounds: 1 });

    // The audited player unlocks sound and starts the game by keyboard.
    await tabTo(host.page, { testId: 'sound-consent' });
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );
    for (const stage of others) {
      await unlockSound(stage.page);
    }

    await tabTo(host.page, { testId: 'start-game' });
    await host.page.keyboard.press('Enter');
    await waitForPhase(host.page, 'SUBMISSION');
    await Promise.all(all.map((page) => waitForPhase(page, 'SUBMISSION')));

    // Submission by keyboard.
    await submitSongByKeyboard(
      host.page,
      'https://www.youtube.com/watch?v=a11ysub0001',
    );
    for (const [index, stage] of others.entries()) {
      const media = mediaFor(1, index + 1);
      expect(
        (await dispatch(stage.page, { type: 'SUBMIT_SONG', media })).status,
      ).toBe('accepted');
      expect(
        (await dispatch(stage.page, { type: 'FINISH_SUBMISSION' })).status,
      ).toBe('accepted');
    }
    await waitForPhase(host.page, 'PLAYBACK');

    // Playback has no keyboard control; the clips are skipped via the session.
    const songCount = (await stateOf(host.page))?.round?.songs.length ?? 0;
    for (let index = 0; index < songCount; index += 1) {
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'VOTING');

    // Ranking by keyboard, exercising both the down and up buttons.
    const hostId = (await snapshot(host.page)).clientId;
    const state = await stateOf(host.page);
    const foreign = (state?.round?.songs ?? [])
      .filter((song) => !song.ownerIds.includes(hostId))
      .map((song) => song.media.videoId);
    expect(foreign).toHaveLength(2);

    await rankAllByKeyboard(host.page, foreign.length);
    await expect
      .poll(() => ballotOf(host.page, hostId))
      .toHaveLength(foreign.length);
    // The pool order is not guaranteed, so use the order the keyboard produced.
    const initial = await ballotOf(host.page, hostId);
    expect([...initial].sort()).toEqual([...foreign].sort());
    const [first, second] = initial as [string, string];

    // Move the current top song down, then back up.
    await moveByKeyboard(host.page, first, 2);
    await expect
      .poll(() => ballotOf(host.page, hostId))
      .toEqual([second, first]);

    await moveByKeyboard(host.page, first, 1);
    await expect
      .poll(() => ballotOf(host.page, hostId))
      .toEqual([first, second]);

    await tabTo(host.page, { testId: 'voting-finish' });
    await host.page.keyboard.press('Enter');
    await expect
      .poll(async () => (await stateOf(host.page))?.round?.votingDoneIds ?? [])
      .toContain(hostId);

    // The remaining voters finish through the session so the round resolves.
    for (const stage of others) {
      await finishVotingFor(stage.page, state);
    }
    await waitForPhase(host.page, 'REVEAL');

    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'FINAL');
    await expect(host.page.getByTestId('final-phase')).toBeVisible();

    // The audited player exercises the Finale control by keyboard.
    await tabTo(host.page, { testId: 'final-rematch' });
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByTestId('room-view')).toHaveAttribute(
      'data-phase',
      'LOBBY',
    );
  } finally {
    await closeStages(stages);
  }
});
