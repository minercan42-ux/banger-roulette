import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRE_ROLL_MS, REVEAL_PER_SONG_MS } from '../src/engine';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  newStage,
  snapshot,
  stateOf,
  type Stage,
} from './m3-support';
import { playToPlayback, ratePlayback } from './m5-support';
import {
  FIXTURE_CHANNEL,
  fixtureThumbnail,
  fixtureTitle,
} from './youtube-fixture';

/**
 * FR-26 Spiritually Linked moment (#135). In the reveal every owner of the
 * shared song gets a card, a name plate and the points they earned, plus the
 * line "+X for A and B"; in the playback preroll the moment is a short,
 * name-free teaser (AK-3). Reduced motion keeps the same facts, calm. A linked
 * entry that carries the banger show does not stack a second show on it.
 */

const DUP = 'm10dupe0001';
const SOLO = 'm10solo0002';

function mediaOf(videoId: string): Media {
  return {
    videoId,
    title: fixtureTitle(videoId),
    channel: FIXTURE_CHANNEL,
    thumbnail: fixtureThumbnail(videoId),
    durationSeconds: 200,
    startSeconds: 0,
  };
}

async function openStages(
  browser: Parameters<typeof newStage>[0],
  nicknames: string[],
  options: Partial<Parameters<typeof newStage>[1]> = {},
): Promise<Stage[]> {
  return Promise.all(
    nicknames.map((nickname) => newStage(browser, { nickname, ...options })),
  );
}

/** End times in ms of every animation inside the stage (delay included). */
function animationEnds(stage: Locator): Promise<number[]> {
  return stage.evaluate((root) =>
    root
      .getAnimations({ subtree: true })
      .map((animation) =>
        Number(animation.effect?.getComputedTiming().endTime),
      ),
  );
}

/** "+8.0" for the tenths an owner earned, as the UI words it. */
function pointsText(tenths: number): string {
  return `${tenths >= 0 ? '+' : '-'}${(Math.abs(tenths) / 10).toFixed(1)}`;
}

/** The points every owner of the first round's linked entry earned. */
async function ownerPoints(
  page: Page,
  owners: Stage[],
): Promise<{ tenths: number; text: string }> {
  const ids = await Promise.all(
    owners.map(async (owner) => (await snapshot(owner.page)).clientId),
  );
  const deltas = (await stateOf(page))?.results[0]?.playerDeltas ?? {};
  const earned = ids.map((id) => deltas[id]);
  expect(new Set(earned).size, 'every owner earns the same points').toBe(1);
  const tenths = earned[0] as number;
  return { tenths, text: pointsText(tenths) };
}

/** Wait until the stage reached its settled frame (last plate popped in). */
async function expectSettled(stage: Locator): Promise<void> {
  await expect(stage.locator('.br-linked__banner')).toHaveCSS('opacity', '1', {
    timeout: 6000,
  });
  const plates = stage.locator('.br-linked__plate');
  await expect(plates.last()).toHaveCSS('opacity', '1', { timeout: 6000 });
  await expect(stage.locator('.br-linkedset__body')).toHaveCSS('opacity', '1');
}

for (const reducedMotion of [false, true] as const) {
  const mode = reducedMotion ? 'reduced motion' : 'full motion';

  test(`reveal shows both owners of a linked song with their points (${mode})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    try {
      const pages = stages.map((stage) => stage.page);
      const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)];
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, medias);
      // Cara is the only one who can rate the linked song: a 2.
      await ratePlayback(pages, medias, (rater, song) =>
        song === 2 ? 9 : rater === 2 ? 2 : null,
      );

      // Every client shows the same facts.
      for (const stage of stages) {
        const linked = stage.page.getByTestId('linked-animation');
        await expect(linked).toHaveAttribute('data-variant', 'reveal', {
          timeout: 10_000,
        });
        await expect(linked.getByTestId('linked-owner')).toHaveCount(2);
        await expect(linked.getByTestId('linked-owner-name')).toHaveText([
          'Alice',
          'Bob',
        ]);
      }

      const host = pages[0]!;
      const linked = host.getByTestId('linked-animation');
      const { text } = await ownerPoints(host, stages.slice(0, 2));
      await expect(linked.getByTestId('linked-owner-points')).toHaveText([
        text,
        text,
      ]);
      await expect(linked.getByTestId('linked-points')).toHaveText(
        `${text} for Alice and Bob`,
      );
      // The entry's own row agrees with the moment.
      await expect(
        host
          .locator(`[data-testid="reveal-entry"][data-video-id="${DUP}"]`)
          .getByTestId('reveal-entry-owners'),
      ).toContainText('Alice, Bob');

      const ends = await animationEnds(linked);
      if (reducedMotion) {
        await expect(linked).toHaveAttribute('data-motion', 'calm');
        // Calm: the cards rest face up, nothing flies, only short fades run.
        await expect(linked.locator('.br-linked__spark')).toHaveCount(0);
        await expect(linked.locator('.br-linked__card.is-flipped')).toHaveCount(
          2,
        );
        expect(Math.max(0, ...ends)).toBeLessThanOrEqual(300);
      } else {
        await expect(linked).toHaveAttribute('data-motion', 'full');
        await expect(linked.locator('.br-linked__spark')).toHaveCount(14);
        // The whole sequence fits the 2500 ms slot of the entry.
        expect(ends.length).toBeGreaterThan(10);
        expect(Math.max(...ends)).toBeGreaterThan(1500);
        expect(Math.max(...ends)).toBeLessThanOrEqual(REVEAL_PER_SONG_MS);
      }
      await expectSettled(linked);
    } finally {
      await closeStages(stages);
    }
  });

  test(`preroll teases the linked song without a name (${mode})`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    try {
      const pages = stages.map((stage) => stage.page);
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)]);

      const host = pages[0]!;
      await expect(host.getByTestId('playback-preroll')).toBeVisible({
        timeout: 5000,
      });
      const linked = host.getByTestId('linked-animation');
      await expect(linked).toHaveAttribute('data-variant', 'preroll');
      await expect(linked.locator('.br-linked__seat')).toHaveCount(2);
      await expect(linked.getByTestId('linked-anonymous')).toBeVisible();
      // AK-3: neither a name nor a point before the reveal.
      await expect(linked.getByTestId('linked-owner')).toHaveCount(0);
      await expect(linked.getByTestId('linked-owner-points')).toHaveCount(0);
      const text = (await linked.innerText()).toLowerCase();
      for (const nickname of ['alice', 'bob', 'cara']) {
        expect(text).not.toContain(nickname);
      }
      // The cards stay face down.
      await expect(linked.locator('.br-linked__card.is-flipped')).toHaveCount(
        0,
      );

      const ends = await animationEnds(linked);
      if (reducedMotion) {
        await expect(linked).toHaveAttribute('data-motion', 'calm');
        expect(Math.max(0, ...ends)).toBeLessThanOrEqual(300);
      } else {
        // It moves, and it is over long before the preroll is.
        expect(ends.length).toBeGreaterThan(5);
        expect(Math.max(...ends)).toBeLessThanOrEqual(PRE_ROLL_MS);
      }
    } finally {
      await closeStages(stages);
    }
  });
}

test('reveal shows all three owners of a linked song on a phone', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara', 'Dario'], {
    viewport: { width: 360, height: 740 },
  });
  try {
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)];
    await assembleRoom(stages[0]!, stages.slice(1));
    await playToPlayback(pages, medias);
    // Dario rates the linked song a 3; the others rate Dario's song a 8.
    await ratePlayback(pages, medias, (rater, song) =>
      song === 3 ? 8 : rater === 3 ? 3 : null,
    );

    const host = pages[0]!;
    const linked = host.getByTestId('linked-animation');
    await expect(linked.getByTestId('linked-owner')).toHaveCount(3, {
      timeout: 10_000,
    });
    await expect(linked.getByTestId('linked-owner-name')).toHaveText([
      'Alice',
      'Bob',
      'Cara',
    ]);
    const { text } = await ownerPoints(host, stages.slice(0, 3));
    await expect(linked.getByTestId('linked-owner-points')).toHaveText([
      text,
      text,
      text,
    ]);
    await expect(linked.getByTestId('linked-points')).toHaveText(
      `${text} for Alice, Bob, and Cara`,
    );
    await expectSettled(linked);

    // Settled, every plate sits inside the stage and the page does not scroll
    // sideways.
    const stage = linked.locator('.br-linked');
    const frame = (await stage.boundingBox())!;
    for (const plate of await linked.locator('.br-linked__plate').all()) {
      const box = (await plate.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    const overflow = await host.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await closeStages(stages);
  }
});

test('a linked banger keeps one show: the banger show owns the viewport', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara']);
  try {
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO)];
    await assembleRoom(stages[0]!, stages.slice(1));
    await playToPlayback(pages, medias);
    // Cara's only rating of the linked song is a 10 (a banger and the round
    // winner); her own song gets a 4 and is revealed first.
    await ratePlayback(pages, medias, (rater, song) =>
      song === 2 ? 4 : rater === 2 ? 10 : null,
    );

    const host = pages[0]!;
    const show = host.getByTestId('banger-show');
    await expect(show).toBeVisible({ timeout: 8000 });
    // Exactly one full-screen show: no jackpot, no second layer from the
    // linked moment, which only rests at its settled frame under the show.
    await expect(host.getByTestId('jackpot-show')).toHaveCount(0);
    await expect(host.locator('[data-testid$="-show"]')).toHaveCount(1);
    const linked = host.getByTestId('linked-animation');
    await expect(linked).toHaveAttribute('data-held', 'true');
    await expect(linked).toHaveAttribute('data-motion', 'calm');
    await expect(linked.locator('.br-linked__spark')).toHaveCount(0);
    await expect(linked.locator('.br-linked__flash')).toHaveCount(0);
    expect(Math.max(0, ...(await animationEnds(linked)))).toBeLessThanOrEqual(
      300,
    );

    // After the show the entry still names both owners with their points.
    await expect(show).toBeHidden({ timeout: 8000 });
    const { text } = await ownerPoints(host, stages.slice(0, 2));
    await expect(linked.getByTestId('linked-owner-name')).toHaveText([
      'Alice',
      'Bob',
    ]);
    await expect(linked.getByTestId('linked-owner-points')).toHaveText([
      text,
      text,
    ]);
    await expect(linked.getByTestId('linked-points')).toHaveText(
      `${text} for Alice and Bob`,
    );
  } finally {
    await closeStages(stages);
  }
});
