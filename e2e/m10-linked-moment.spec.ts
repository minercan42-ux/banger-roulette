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
import { playToPlayback, ratePlayback, type RatingFn } from './m5-support';
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
 * entry that carries the banger show does not stack a second show on it. The
 * moment has to be seen: the impact and the settled owners and points sit
 * inside the viewport of the player (1280x800 and 360x740).
 */

const DUP = 'm10dupe0001';
const SOLO_A = 'm10solo0002';
const SOLO_B = 'm10solo0003';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 740 };

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

/** The element lies completely inside the viewport right now. */
async function expectInViewport(
  page: Page,
  target: Locator,
  what: string,
): Promise<void> {
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        return (
          box !== null &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height
        );
      },
      {
        message: `${what} is inside the ${viewport.width}x${viewport.height} viewport`,
      },
    )
    .toBe(true);
}

/** The sticky bars of a phone (top bar, action bar) do not cover `target`. */
async function expectClearOfBars(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  for (const bar of ['.br-table__top', '.br-table__actions']) {
    const barBox = await page.locator(bar).first().boundingBox();
    if (barBox === null) {
      continue;
    }
    const overlaps =
      box.y < barBox.y + barBox.height && box.y + box.height > barBox.y;
    expect(overlaps, `${bar} does not cover the linked moment`).toBe(false);
  }
}

interface ImpactSample {
  top: number;
  bottom: number;
  left: number;
  right: number;
  vh: number;
  vw: number;
}

declare global {
  interface Window {
    __impact?: ImpactSample[];
  }
}

/**
 * Samples the stage on every frame while its cards are between collision and
 * the end of the shake (700..1100 ms of the timeline): where the stage was on
 * screen at the impact. Installed before the reveal starts, read afterwards.
 */
function sampleImpact(page: Page): Promise<void> {
  return page.evaluate(() => {
    const samples: ImpactSample[] = [];
    window.__impact = samples;
    const tick = () => {
      const root = document.querySelector('[data-testid="linked-animation"]');
      const stage = root?.querySelector('.br-linked');
      const card = root?.querySelector('.br-linked__cardbox');
      const time = card?.getAnimations()[0]?.currentTime;
      if (stage && typeof time === 'number' && time >= 700 && time <= 1100) {
        const rect = stage.getBoundingClientRect();
        samples.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          vh: innerHeight,
          vw: innerWidth,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function expectImpactSeen(page: Page): Promise<void> {
  const samples = await page.evaluate(() => window.__impact ?? []);
  expect(samples.length, 'the impact was sampled').toBeGreaterThan(3);
  for (const sample of samples) {
    expect(sample.top).toBeGreaterThanOrEqual(0);
    expect(sample.bottom).toBeLessThanOrEqual(sample.vh);
    expect(sample.left).toBeGreaterThanOrEqual(0);
    expect(sample.right).toBeLessThanOrEqual(sample.vw);
  }
}

/** Alice and Bob (DUP) land between Cara's worst and Dario's best song. */
const TWO_OWNERS: RatingFn = (rater, song) =>
  song < 2 ? (rater >= 2 ? 5 : null) : song === 2 ? 3 : 9;

/** Alice, Bob and Cara (DUP) land between Dario's worst and Eve's best song. */
const THREE_OWNERS: RatingFn = (rater, song) =>
  song < 3 ? (rater >= 3 ? 5 : null) : song === 3 ? 3 : 9;

for (const reducedMotion of [false, true] as const) {
  const mode = reducedMotion ? 'reduced motion' : 'full motion';

  test(`reveal shows both owners of a linked song with their points, in view (${mode})`, async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const stages = await openStages(
      browser,
      ['Alice', 'Bob', 'Cara', 'Dario'],
      {
        viewport: DESKTOP,
        reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
      },
    );
    try {
      const pages = stages.map((stage) => stage.page);
      const medias = [
        mediaOf(DUP),
        mediaOf(DUP),
        mediaOf(SOLO_A),
        mediaOf(SOLO_B),
      ];
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, medias);
      await Promise.all(pages.map(sampleImpact));
      await ratePlayback(pages, medias, TWO_OWNERS);

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
        // The player saw the impact: the stage was inside the viewport then.
        await expectImpactSeen(host);
      }
      await expectSettled(linked);

      // The payoff is on screen without scrolling: plates, points, line.
      await expectInViewport(
        host,
        linked.locator('.br-linked__banner'),
        'banner',
      );
      for (const plate of await linked.locator('.br-linked__plate').all()) {
        await expectInViewport(host, plate, 'owner plate');
      }
      await expectInViewport(
        host,
        linked.getByTestId('linked-points'),
        'points line',
      );
    } finally {
      await closeStages(stages);
    }
  });

  test(`preroll teases the linked song without a name, in view (${mode})`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
      viewport: DESKTOP,
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    try {
      const pages = stages.map((stage) => stage.page);
      await assembleRoom(stages[0]!, stages.slice(1));
      await playToPlayback(pages, [
        mediaOf(DUP),
        mediaOf(DUP),
        mediaOf(SOLO_A),
      ]);

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
      // The teaser floats over the viewport: no scrolling to find it.
      await expectInViewport(
        host,
        linked.locator('.br-linked'),
        'preroll teaser',
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

test('reveal shows all three owners of a linked song on a phone, in German', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const stages = await openStages(
    browser,
    ['Alice', 'Bob', 'Cara', 'Dario', 'Eve'],
    { viewport: PHONE, locale: 'de-DE' },
  );
  try {
    const pages = stages.map((stage) => stage.page);
    const medias = [
      mediaOf(DUP),
      mediaOf(DUP),
      mediaOf(DUP),
      mediaOf(SOLO_A),
      mediaOf(SOLO_B),
    ];
    await assembleRoom(stages[0]!, stages.slice(1));
    await playToPlayback(pages, medias);
    // The phone teaser is inside the 360x740 viewport too.
    const host = pages[0]!;
    await expect(host.getByTestId('linked-animation')).toHaveAttribute(
      'data-variant',
      'preroll',
      { timeout: 5000 },
    );
    await expectInViewport(
      host,
      host.getByTestId('linked-animation').locator('.br-linked'),
      'preroll teaser',
    );
    await sampleImpact(host);
    await ratePlayback(pages, medias, THREE_OWNERS);

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
      `${text} für Alice, Bob und Cara`,
    );
    await expectImpactSeen(host);
    await expectSettled(linked);

    // Settled, the whole moment sits inside the viewport, clear of the sticky
    // bars, every plate inside the stage, and the page does not scroll sideways.
    const stage = linked.locator('.br-linked');
    await expectInViewport(host, stage, 'linked stage');
    await expectInViewport(
      host,
      linked.getByTestId('linked-points'),
      'points line',
    );
    await expectClearOfBars(host, stage);
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
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
    viewport: DESKTOP,
  });
  try {
    const pages = stages.map((stage) => stage.page);
    const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO_A)];
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
