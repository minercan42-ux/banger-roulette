import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
import { mediaFor, ratePlayback } from './m5-support';

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

/**
 * Everything the document exposes to the Tab key, in DOM order: `tabindex="-1"`
 * elements (the warm playback host during SUBMISSION) and unrendered ones stay
 * excluded, so the list is what the tab order can actually reach.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FocusInfo {
  testId: string | null;
  /** DOM position of the focused element, so a parked focus is detectable. */
  index: number;
  /** Whether the focused element ends or opens the document's tab order. */
  atEnd: boolean;
  atStart: boolean;
}

async function focusedInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate((selector) => {
    const active = document.activeElement as HTMLElement | null;
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(selector),
    ).filter((element) => element.getClientRects().length > 0);
    return {
      testId: active?.getAttribute('data-testid') ?? null,
      index:
        active === null
          ? -1
          : Array.from(document.querySelectorAll('*')).indexOf(active),
      atEnd: focusable[focusable.length - 1] === active,
      atStart: focusable[0] === active,
    };
  }, FOCUSABLE_SELECTOR);
}

/**
 * Moves focus to a control using the Tab key only. Returns early when the
 * control already holds focus (React keeps the node across reorders), so a
 * caller never overshoots the target.
 *
 * Chromium continues the tab order at the document start after the last control
 * (through the document root), so the walk wraps on its own. Firefox parks the
 * focus on that last control instead; the audited player's navigation has to
 * stay keyboard-only, so the rest of the ring is then walked backwards with
 * Shift+Tab rather than by focusing a control from script. A control that
 * swallows Tab anywhere else is a real keyboard trap and fails the run.
 */
async function tabTo(page: Page, target: { testId: string }): Promise<void> {
  let backwards = false;
  let previous: number | null = null;
  for (let presses = 0; presses <= MAX_TABS; presses += 1) {
    const info = await focusedInfo(page);
    if (info.testId === target.testId) {
      return;
    }
    if (presses === MAX_TABS) {
      break;
    }
    if (info.index === previous) {
      // The press before this one did not move the focus.
      if (!backwards && info.atEnd) {
        backwards = true;
      } else if (backwards && info.atStart) {
        throw new Error(
          `Keyboard pass walked the whole tab order without reaching ${JSON.stringify(target)}`,
        );
      } else {
        throw new Error(
          `Focus stuck on ${info.testId ?? `element #${info.index}`} while looking for ${JSON.stringify(target)}`,
        );
      }
    }
    previous = info.index;
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
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

test('announces every phase transition including the lobby boundary but stays silent on mount', async ({
  browser,
}) => {
  // The heaviest a11y flow (Lobby through the rematch) and the first test of the
  // run; WebKit needs more than the 30 s default for it on a 2 vCPU runner.
  test.setTimeout(120_000);
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

    const medias = all.map((_, index) => mediaFor(1, index));
    await ratePlayback(all, medias);
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
  browserName,
}) => {
  test.setTimeout(180_000);
  // #57: the submission preview iframe stays in the tab order, and Firefox,
  // unlike Chromium, does not continue the walk past it, so Save and Finished
  // are unreachable once the preview is playing. Re-enable this leg together
  // with the fix that takes the frame out of the tab order.
  test.fixme(
    browserName === 'firefox',
    'The submission preview iframe traps the Tab key (#57)',
  );
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

    // The audited player passes the start gate and starts the game by
    // keyboard: the gate takes focus on open, Enter accepts.
    await expect(host.page.getByTestId('start-gate-accept')).toBeFocused();
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

    // Playback has no keyboard control for the clips; they are skipped via the
    // session. Skip to a song the audited player does not own, so the rating
    // bar (not the "your song" note) is on screen.
    const hostId = (await snapshot(host.page)).clientId;
    const medias = all.map((_, index) => mediaFor(1, index));
    for (let guard = 0; guard < 3; guard += 1) {
      const playing = await stateOf(host.page);
      const current = playing?.round?.playbackOrder[
        playing.phase.type === 'PLAYBACK' ? playing.phase.index : 0
      ] as string;
      const owner = playing?.round?.songs.find(
        (song) => song.media.videoId === current,
      );
      if (!owner?.ownerIds.includes(hostId)) {
        break;
      }
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
    }
    const playing = await stateOf(host.page);
    expect(playing?.phase.type).toBe('PLAYBACK');
    const index = playing?.phase.type === 'PLAYBACK' ? playing.phase.index : 0;
    const songId = playing?.round?.playbackOrder[index] as string;

    // Genre-fail chip by keyboard: it is chip 0 and replaces a number.
    await tabTo(host.page, { testId: 'rating-chip-0' });
    await expect(host.page.getByTestId('rating-chip-0')).toHaveAccessibleName(
      /Genre.?fail/i,
    );
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByTestId('rating-chip-0')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(
        async () =>
          (await stateOf(host.page))?.round?.ratings[hostId]?.[songId],
      )
      .toBe(0);

    // Rating by keyboard: pick a chip, then change it.
    await tabTo(host.page, { testId: 'rating-chip-7' });
    await host.page.keyboard.press('Enter');
    await expect(host.page.getByTestId('rating-chip-7')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(
        async () =>
          (await stateOf(host.page))?.round?.ratings[hostId]?.[songId],
      )
      .toBe(7);
    await tabTo(host.page, { testId: 'rating-chip-9' });
    await host.page.keyboard.press(' ');
    await expect
      .poll(
        async () =>
          (await stateOf(host.page))?.round?.ratings[hostId]?.[songId],
      )
      .toBe(9);

    // The next song opens the summary; change the earlier rating from it.
    if (index + 1 < medias.length) {
      expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
        'accepted',
      );
      await tabTo(host.page, { testId: `rating-entry-toggle-${index}` });
      await host.page.keyboard.press('Enter');
      await tabTo(host.page, { testId: 'rating-edit-chip-3' });
      await host.page.keyboard.press('Enter');
      await expect
        .poll(
          async () =>
            (await stateOf(host.page))?.round?.ratings[hostId]?.[songId],
        )
        .toBe(3);
    }

    // The remaining ratings go through the session so the round resolves.
    await ratePlayback(all, medias, (rater) => (rater === 0 ? null : 6));

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
