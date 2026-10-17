import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  assembleRoom,
  closeStages,
  dispatch,
  enterSubmission,
  newStage,
  setSettings,
  snapshot,
  waitForPhase,
  type Stage,
} from './m3-support';
import { mediaFor, ratePlayback } from './m5-support';

/**
 * Issue #96: one start popup for the YouTube consent and the audio unlock.
 * New visitor: one popup, one click, then nothing else asks. Reload: consent
 * is remembered, only a one-tap sound gate. "Ohne Videos": no request to
 * YouTube. Revoke: stored consent is forgotten.
 */

const CONSENT_KEY = 'banger-roulette.youtubeConsent';

/** Every prompt the old per-phase flow showed must be gone. */
async function expectNoPrompts(page: Page): Promise<void> {
  for (const testId of [
    'start-gate',
    'youtube-consent',
    'playback-consent',
    'sound-consent',
  ]) {
    await expect(page.getByTestId(testId), testId).toHaveCount(0);
  }
}

async function storedConsent(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY);
}

async function startPlayers(
  browser: Parameters<typeof newStage>[0],
  count: number,
  options: { locale?: string } = {},
): Promise<Stage[]> {
  const names = ['Alice', 'Bruno', 'Cleo'];
  return Promise.all(
    names
      .slice(0, count)
      .map((nickname) => newStage(browser, { nickname, ...options })),
  );
}

test('new visitor: one popup, one click, then nothing asks again through rematch', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await startPlayers(browser, 3);
  try {
    const [host] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    await assembleRoom(host, stages.slice(1));
    await setSettings(host.page, { rounds: 1 });

    // The popup: a modal dialog, full form, focus inside, Esc does nothing.
    const gate = host.page.getByTestId('start-gate');
    await expect(gate).toHaveAttribute('data-mode', 'full');
    await expect(gate.getByRole('dialog')).toHaveAttribute(
      'aria-modal',
      'true',
    );
    await expect(host.page.getByTestId('start-gate-accept')).toBeFocused();
    await host.page.keyboard.press('Escape');
    await expect(gate).toBeVisible();
    for (let step = 0; step < 4; step += 1) {
      await host.page.keyboard.press('Tab');
      const inside = await host.page.evaluate(() =>
        document
          .querySelector('[data-testid="start-gate"]')!
          .contains(document.activeElement),
      );
      expect(inside, `Tab step ${step} stays in the gate`).toBe(true);
    }
    // Nothing is stored and nothing was requested before the click.
    expect(await storedConsent(host.page)).toBeNull();
    expect(host.youtubeRequests()).toEqual([]);

    // One click per player.
    for (const page of pages) {
      await page.getByTestId('start-gate-accept').click();
      await expect(page.getByTestId('start-gate')).toHaveCount(0);
      await expect(page.getByTestId('sound-status')).toHaveAttribute(
        'data-unlocked',
        'true',
      );
      expect(await storedConsent(page)).toBe('1');
    }

    // LOBBY: neither the old sound step nor any consent checkbox.
    for (const page of pages) {
      await expectNoPrompts(page);
    }

    expect((await dispatch(host.page, { type: 'START_GAME' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'GENRE_SPIN');
    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'SUBMISSION');
    await Promise.all(pages.map((page) => waitForPhase(page, 'SUBMISSION')));
    for (const page of pages) {
      await expectNoPrompts(page);
      await expect(page.getByTestId('submission-consent-required')).toHaveCount(
        0,
      );
    }

    const medias = pages.map((_, index) => mediaFor(1, index));
    for (const [index, page] of pages.entries()) {
      expect(
        (await dispatch(page, { type: 'SUBMIT_SONG', media: medias[index] }))
          .status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_SUBMISSION' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'PLAYBACK');
    await Promise.all(pages.map((page) => waitForPhase(page, 'PLAYBACK')));
    for (const page of pages) {
      await expectNoPrompts(page);
      await expect(page.getByTestId('playback-consent-required')).toHaveCount(
        0,
      );
    }

    await ratePlayback(pages, medias);
    for (const page of pages) {
      await expectNoPrompts(page);
    }

    expect((await dispatch(host.page, { type: 'ADVANCE' })).status).toBe(
      'accepted',
    );
    await waitForPhase(host.page, 'FINAL');
    await host.page.getByTestId('final-rematch').click();
    await Promise.all(pages.map((page) => waitForPhase(page, 'LOBBY')));
    for (const page of pages) {
      await expectNoPrompts(page);
      await expect(page.getByTestId('sound-status')).toHaveAttribute(
        'data-unlocked',
        'true',
      );
    }
  } finally {
    await closeStages(stages);
  }
});

test('reload: the consent is remembered and only a one-tap sound gate remains', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  // Bruno reloads while Alice keeps the room alive for him.
  const stages = await startPlayers(browser, 2, { locale: 'de-DE' });
  const page = stages[1]!.page;
  try {
    await assembleRoom(stages[0]!, [stages[1]!]);

    // German first-visit popup with both buttons.
    await expect(page.getByTestId('start-gate-accept')).toHaveText(
      "Los geht's",
    );
    await expect(page.getByTestId('start-gate-decline')).toHaveText(
      'Ohne Videos',
    );
    await page.getByTestId('start-gate-accept').click();
    await expect(page.getByTestId('start-gate')).toHaveCount(0);
    expect(await storedConsent(page)).toBe('1');

    // After a reload the consent stays, the audio permission does not.
    await page.reload();
    await expect(page.getByTestId('room-view')).toBeVisible({ timeout: 20000 });
    const gate = page.getByTestId('start-gate');
    await expect(gate).toHaveAttribute('data-mode', 'compact');
    await expect(page.getByTestId('start-gate-decline')).toHaveCount(0);
    await expect(page.getByTestId('start-gate-accept')).toHaveText(
      'Tippen zum Starten',
    );
    expect(await storedConsent(page)).toBe('1');
    await page.getByTestId('start-gate-accept').click();
    await expect(gate).toHaveCount(0);
    await expect(page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );

    // Esc closes the one-tap form; the status control keeps a manual retry.
    await page.reload();
    await expect(page.getByTestId('start-gate')).toHaveAttribute(
      'data-mode',
      'compact',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('start-gate')).toHaveCount(0);
    await expect(page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'false',
    );
    await page.getByTestId('sound-consent').click();
    await expect(page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );
  } finally {
    await closeStages(stages);
  }
});

test('"Ohne Videos": the game runs without any request to YouTube', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const stages = await startPlayers(browser, 3);
  try {
    const [host, ...rest] = stages as [Stage, Stage, Stage];
    const pages = stages.map((stage) => stage.page);
    await assembleRoom(host, rest);
    await setSettings(host.page, { rounds: 1 });

    await host.page.getByTestId('start-gate-decline').click();
    await expect(host.page.getByTestId('start-gate')).toHaveCount(0);
    await expect(host.page.getByTestId('sound-status')).toHaveAttribute(
      'data-unlocked',
      'true',
    );
    // Declining is not stored and does not turn consent on.
    expect(await storedConsent(host.page)).toBeNull();
    await expect(host.page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'false',
    );

    await enterSubmission(pages, { withoutVideos: [host.page] });
    await expect(
      host.page.getByTestId('submission-consent-required'),
    ).toBeVisible();
    // A pasted link starts no preview and sends no request without consent.
    await host.page
      .getByTestId('song-link')
      .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await host.page.waitForTimeout(1500);
    await expect(
      host.page.getByTestId('preview-host').locator('iframe'),
    ).toHaveCount(0);
    expect(host.youtubeRequests()).toEqual([]);
    await expect(
      host.page.getByTestId('submission-consent-required'),
    ).toBeVisible();

    const medias = pages.map((_, index) => mediaFor(1, index));
    for (const [index, page] of pages.entries()) {
      expect(
        (await dispatch(page, { type: 'SUBMIT_SONG', media: medias[index] }))
          .status,
      ).toBe('accepted');
      expect((await dispatch(page, { type: 'FINISH_SUBMISSION' })).status).toBe(
        'accepted',
      );
    }
    await waitForPhase(host.page, 'PLAYBACK');
    await expect(
      host.page.getByTestId('playback-consent-required'),
    ).toBeVisible();
    await ratePlayback(pages, medias);
    await expect(host.page.getByTestId('reveal-phase')).toBeVisible();

    // The declining player never touched a YouTube domain, nor a thumbnail.
    expect(host.youtubeRequests()).toEqual([]);
    await expect(host.page.locator('[data-testid*="thumbnail"]')).toHaveCount(
      0,
    );
    // The two consenting players did.
    expect(stages[1]!.youtubeRequests().length).toBeGreaterThan(0);
  } finally {
    await closeStages(stages);
  }
});

test('revoke: the drawer forgets the consent and the next visit asks again', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stages = await startPlayers(browser, 2);
  const page = stages[1]!.page;
  try {
    await assembleRoom(stages[0]!, [stages[1]!]);
    await page.getByTestId('start-gate-accept').click();
    await expect(page.getByTestId('start-gate')).toHaveCount(0);
    expect(await storedConsent(page)).toBe('1');
    await expect(page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'true',
    );

    await page.getByTestId('consent-revoke').click();
    await expect(page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'false',
    );
    expect(await storedConsent(page)).toBeNull();
    // Revoking is a decision for this page load: no popup right away, and the
    // same place offers to grant it again.
    await expect(page.getByTestId('start-gate')).toHaveCount(0);
    await expect(page.getByTestId('consent-grant')).toBeVisible();
    await page.getByTestId('consent-grant').click();
    await expect(page.getByTestId('consent-status')).toHaveAttribute(
      'data-consented',
      'true',
    );
    expect(await storedConsent(page)).toBe('1');

    await page.getByTestId('consent-revoke').click();
    await page.reload();
    await expect(page.getByTestId('room-view')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('start-gate')).toHaveAttribute(
      'data-mode',
      'full',
    );
    expect((await snapshot(page)).state?.roomCode).toBeTruthy();
  } finally {
    await closeStages(stages);
  }
});
