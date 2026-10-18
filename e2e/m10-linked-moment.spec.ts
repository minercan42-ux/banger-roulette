import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRE_ROLL_MS, REVEAL_PER_SONG_MS } from '../src/engine';
import type { Media } from '../src/shared/primitives';
import {
  assembleRoom,
  closeStages,
  dispatch,
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
  /**
   * Timeline position of the reveal moment in ms when the sample was taken:
   * the furthest `currentTime` of its animations (a finished animation stays
   * at its end, so the first one alone would stop at 1000 ms); null while
   * none has a numeric one yet.
   */
  time: number | null;
  animations: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  vh: number;
  vw: number;
  /** Page scroll offset of the sample: two samples moved nothing. */
  scrollX: number;
  scrollY: number;
}

declare global {
  interface Window {
    __impact?: ImpactSample[];
  }
}

/**
 * Samples the stage of the reveal moment (not the preroll teaser, which is a
 * second `linked-animation` in the video frame during PLAYBACK and ran the same
 * flight earlier): the stage has to be on screen when the cards hit (700 ms
 * into the timeline) and stay there. Installed before the reveal starts, read
 * once the shake is over.
 *
 * The sampler is a `requestAnimationFrame` loop, so every painted frame is one
 * sample, whatever the frame rate; the assertion asks for one frame inside the
 * shake, not for a count (a count measured the frame rate). A frame whose
 * animations have no `startTime` yet still has a `currentTime` and is sampled.
 * Every frame is stored, also outside the impact window, so a failure shows
 * what the browser painted instead of "no sample".
 */
function sampleImpact(page: Page): Promise<void> {
  return page.evaluate(() => {
    const samples: ImpactSample[] = [];
    window.__impact = samples;
    const tick = () => {
      const root = document.querySelector(
        '[data-testid="linked-animation"][data-variant="reveal"]',
      );
      const stage = root?.querySelector('.br-linked');
      if (root && stage) {
        const times = root
          .getAnimations({ subtree: true })
          .map((animation) => animation.currentTime)
          .filter((time): time is number => typeof time === 'number');
        const rect = stage.getBoundingClientRect();
        samples.push({
          time: times.length > 0 ? Math.max(...times) : null,
          animations: times.length,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          vh: innerHeight,
          vw: innerWidth,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Start of the shake, when the cards hit the entry's timeline. */
const IMPACT_MS = 700;
/** End of the shake. */
const IMPACT_SHAKE_END_MS = 1100;
/**
 * How far the stage's own layout may settle between the two bracketing samples
 * (px): while the plates pop in the entry above it finishes its count-up, so
 * the stage's top moved 2 px between the samples of both `workflow_dispatch`
 * runs of #155. A scroll is not covered by this bound: the proof rejects two
 * samples whose scroll offsets differ at all.
 */
const IMPACT_SETTLE_PX = 4;

/** The stage lies completely inside the viewport of its own sample. */
function onScreen(sample: ImpactSample): boolean {
  return (
    sample.top >= 0 &&
    sample.left >= 0 &&
    sample.bottom <= sample.vh &&
    sample.right <= sample.vw
  );
}

/** Every painted frame, for a failure message that shows what was painted. */
function framesText(samples: ImpactSample[]): string {
  return samples
    .slice(0, 80)
    .map(
      (sample) =>
        `${Math.round(sample.time ?? -1)}/${sample.animations}@${Math.round(
          sample.top,
        )}`,
    )
    .join(' ');
}

/**
 * FR-26: the reveal moment has to be seen. The stage has to sit inside the
 * viewport when the cards hit at `IMPACT_MS`, and stay there for the rest of
 * the entry's slot.
 *
 * Chromium and WebKit prove that with a painted frame inside the shake
 * (700..1100 ms). The WebKit CI runner is frame-starved (2 or 3 painted frames
 * over 1.5 s, dispatch run 39156970605), so when no frame landed inside the
 * window the impact is proven by the frames on both sides of it instead:
 * in view at or before 700 ms and in view at or after 1100 ms, at the same
 * place. That is sound because the entry mounts and the only programmatic
 * scroll of the reveal runs in the mount's layout effect, before the first
 * sample, the test sends no input, and the two samples carry the same scroll
 * offset and the same position: nothing moved the stage while the cards hit.
 * Which proof was used is recorded as an annotation, so no relaxation is
 * silent.
 */
async function expectImpactSeen(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() === 'firefox') {
    // Browser limitation, see docs/OPEN_QUESTIONS.md "Cross-browser findings
    // (#140)": headless Firefox paints this page slowly (one to four frames
    // per second measured on a loaded host). In the CI job no sample fell
    // into the impact window. Chromium and WebKit run the check.
    test.info().annotations.push({
      type: 'limitation',
      description: 'impact position not asserted: Firefox frame clock',
    });
    return;
  }
  // The test gets here a few hundred ms into the entry's slot: wait until a
  // frame past the shake was painted (the sampler keeps running), then read.
  // If none comes, the assertion below fails with the frames it did get.
  await page
    .waitForFunction(
      (shakeEnd: number) =>
        (window.__impact ?? []).some((sample) => (sample.time ?? 0) > shakeEnd),
      IMPACT_SHAKE_END_MS,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  const all = await page.evaluate(() => window.__impact ?? []);
  const frames = `all ${all.length} frames: ${framesText(all)}`;
  const slot = all.filter(
    (sample): sample is ImpactSample & { time: number } =>
      sample.time !== null &&
      sample.time >= IMPACT_MS &&
      sample.time <= REVEAL_PER_SONG_MS,
  );
  // Every sample of the slot keeps the stage on screen: the moment stays seen.
  for (const sample of slot) {
    expect(
      onScreen(sample),
      `the stage is on screen at ${Math.round(sample.time)} ms; ${frames}`,
    ).toBe(true);
  }
  const inside = slot.filter((sample) => sample.time <= IMPACT_SHAKE_END_MS);
  if (inside.length > 0) {
    test.info().annotations.push({
      type: 'impact',
      description: `a painted frame inside the shake (${Math.round(
        inside[0].time,
      )} ms): the stage was on screen at the impact`,
    });
    return;
  }
  // No frame inside the shake. The runner painted none there, so the proof
  // comes from the frames on both sides of the window.
  const before = all
    .filter(
      (sample): sample is ImpactSample & { time: number } =>
        sample.time !== null && sample.time <= IMPACT_MS,
    )
    .at(-1);
  const after = slot.at(0);
  expect(
    before !== undefined && after !== undefined,
    `a painted frame on both sides of the shake (700..1100 ms); ${frames}`,
  ).toBe(true);
  if (before === undefined || after === undefined) {
    return;
  }
  expect(
    before.scrollX === after.scrollX && before.scrollY === after.scrollY,
    `the page did not scroll while the cards hit (${Math.round(
      before.scrollY,
    )} -> ${Math.round(after.scrollY)} px); ${frames}`,
  ).toBe(true);
  for (const [side, sample] of [
    ['before', before],
    ['after', after],
  ] as const) {
    expect(
      onScreen(sample),
      `the stage is on screen ${side} the shake (top ${Math.round(
        sample.top,
      )}, bottom ${Math.round(sample.bottom)} of ${sample.vh}); ${frames}`,
    ).toBe(true);
  }
  for (const [axis, first, second] of [
    ['top', before.top, after.top],
    ['left', before.left, after.left],
  ] as const) {
    expect(
      Math.abs(first - second),
      `the stage sits at the same ${axis} on both sides of the shake; ${frames}`,
    ).toBeLessThanOrEqual(IMPACT_SETTLE_PX);
  }
  test.info().annotations.push({
    type: 'impact',
    description: `no frame inside the shake: the stage was on screen at ${Math.round(
      before.time,
    )} ms and at ${Math.round(
      after.time,
    )} ms, same scroll and position (proof by the frames around the window)`,
  });
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
      // The teaser sits inside the video frame and inside the viewport: no
      // scrolling to find it. The host's pause holds the preroll's frame (the
      // same state the placement test reads), so the box is read in one pass
      // and cannot land on an unmounted teaser after the three preroll
      // seconds (see prerollGeometry).
      expect((await dispatch(host, { type: 'PAUSE' })).status).toBe('accepted');
      await expect(host.getByTestId('pause-banner')).toBeVisible();
      const geometry = await prerollGeometry(host);
      expectInside(geometry.teaser, geometry.frame, 'preroll teaser');
      expectInViewportBox(geometry.teaser, geometry.viewport, 'preroll teaser');

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
    // One pass, while the preroll runs: a poll would outlive the three preroll
    // seconds on the frame-starved runner (see prerollGeometry).
    const teaser = await prerollGeometry(host);
    expectInViewportBox(teaser.teaser, teaser.viewport, 'preroll teaser');
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

    // The entry names both owners with their points while the show is up: the
    // show and the entry end together, so this is the last moment the reveal
    // list is guaranteed to carry the moment. On the frame-starved runner the
    // reveal clock (the animation frame clock) stops with the frames, the
    // show then runs on into the reveal's hold and goes away with the round,
    // so "after the show" is not a window to read (dispatch run 39156970605,
    // docs/OPEN_QUESTIONS.md "Cross-browser findings (#140)").
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

    // The show goes away (its slot ends, or the round does) and no second show
    // is left: the linked moment never stacked one on the show.
    await expect(show).toBeHidden({ timeout: 8000 });
    await expect(host.locator('[data-testid$="-show"]')).toHaveCount(0);
  } finally {
    await closeStages(stages);
  }
});

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PrerollGeometry {
  frame: Rect;
  teaser: Rect;
  /** The viewport the teaser has to sit in, at the same instant. */
  viewport: Rect;
  /** The controls the teaser must never cover, by test id. */
  controls: Record<string, { box: Rect; inStickyBar: boolean }>;
  /** The sticky bars' z-index is above the teaser slot's. */
  barAboveTeaser: boolean;
}

/**
 * One synchronous read of the preroll: the viewport, the video frame, the
 * teaser, the controls. The teaser lives for the three seconds of the preroll
 * (and holds its frame while the host paused), so its box is read in one pass
 * instead of being polled: on the frame-starved WebKit CI runner a poll can
 * outlive the preroll and the unmounted teaser (dispatch run 39156970605, see
 * docs/OPEN_QUESTIONS.md "Cross-browser findings (#140)").
 */
function prerollGeometry(page: Page): Promise<PrerollGeometry> {
  return page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    const find = (selector: string) => document.querySelector(selector);
    const frame = find('[data-testid="playback-host"]');
    const teaser = find('[data-testid="linked-animation"] .br-linkedset__item');
    const slot = find('.br-stage-video__preroll');
    if (frame === null || teaser === null || slot === null) {
      throw new Error('the preroll teaser is not on screen');
    }
    const controls: PrerollGeometry['controls'] = {};
    for (const id of [
      'rating-section',
      'rating-bar',
      'playback-skip',
      'host-pause',
      'host-resume',
    ]) {
      const element = find(`[data-testid="${id}"]`);
      if (element !== null) {
        controls[id] = {
          box: rect(element),
          inStickyBar:
            element.closest('.br-table__actions, .br-table__top') !== null &&
            getComputedStyle(
              element.closest('.br-table__actions, .br-table__top')!,
            ).position === 'sticky',
        };
      }
    }
    const zOf = (element: Element) =>
      Number(getComputedStyle(element).zIndex) || 0;
    const bar = find('.br-table__actions');
    return {
      frame: rect(frame),
      teaser: rect(teaser),
      viewport: { x: 0, y: 0, w: innerWidth, h: innerHeight },
      controls,
      barAboveTeaser: bar !== null && zOf(bar) > zOf(slot),
    };
  });
}

/**
 * The box lies completely inside the viewport of the same synchronous read
 * (strict, no subpixel slack: this is the "no scrolling to find it" claim).
 */
function expectInViewportBox(box: Rect, viewport: Rect, what: string): void {
  const size = `${viewport.w}x${viewport.h}`;
  expect(
    box.x,
    `${what} left edge inside the ${size} viewport`,
  ).toBeGreaterThanOrEqual(viewport.x);
  expect(
    box.y,
    `${what} top edge inside the ${size} viewport`,
  ).toBeGreaterThanOrEqual(viewport.y);
  expect(
    box.x + box.w,
    `${what} right edge inside the ${size} viewport`,
  ).toBeLessThanOrEqual(viewport.x + viewport.w);
  expect(
    box.y + box.h,
    `${what} bottom edge inside the ${size} viewport`,
  ).toBeLessThanOrEqual(viewport.y + viewport.h);
}

function expectInside(inner: Rect, outer: Rect, what: string): void {
  expect(inner.x, `${what} left edge`).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.y, `${what} top edge`).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(inner.x + inner.w, `${what} right edge`).toBeLessThanOrEqual(
    outer.x + outer.w + 0.5,
  );
  expect(inner.y + inner.h, `${what} bottom edge`).toBeLessThanOrEqual(
    outer.y + outer.h + 0.5,
  );
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/**
 * Teaser inside the frame, horizontally centred on it, clear of every control;
 * on desktop also vertically centred (a phone's sticky action bar covers the
 * frame's lower part, see the phone test for the clearance from it). A control
 * in a sticky bar (the phone's action bar) may sit over the frame's box when
 * the page is scrolled; there the bar has to paint above the teaser.
 */
function expectTeaserPlaced(
  geometry: PrerollGeometry,
  what: string,
  phone: boolean,
): void {
  const { frame, teaser, controls, barAboveTeaser } = geometry;
  expectInside(teaser, frame, `${what}: teaser`);
  expect(
    Math.abs(teaser.x + teaser.w / 2 - (frame.x + frame.w / 2)),
    `${what}: horizontally centred on the video`,
  ).toBeLessThanOrEqual(1);
  if (!phone) {
    expect(
      Math.abs(teaser.y + teaser.h / 2 - (frame.y + frame.h / 2)),
      `${what}: vertically centred on the video`,
    ).toBeLessThanOrEqual(1);
  }
  expect(Object.keys(controls)).toContain('rating-section');
  for (const [id, control] of Object.entries(controls)) {
    if (control.inStickyBar) {
      expect(
        barAboveTeaser,
        `${what}: the sticky bar with ${id} paints above the teaser`,
      ).toBe(true);
      continue;
    }
    expect(
      intersects(teaser, control.box),
      `${what}: the teaser does not cover ${id}`,
    ).toBe(false);
  }
}

for (const [size, viewport] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`preroll teaser sits in the video frame and never covers the controls (${size})`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
      viewport,
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
      const phone = size === 'phone';
      const rating = host.getByTestId('rating-section');
      await expect(host.getByTestId('linked-animation')).toHaveAttribute(
        'data-variant',
        'preroll',
        { timeout: 5000 },
      );

      // Running, then with the rating section scrolled into the middle.
      expectTeaserPlaced(await prerollGeometry(host), 'running', phone);
      await rating.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      expectTeaserPlaced(
        await prerollGeometry(host),
        'running, scrolled',
        phone,
      );

      // Paused (the preroll holds its frame), unscrolled and scrolled again.
      expect((await dispatch(host, { type: 'PAUSE' })).status).toBe('accepted');
      await expect(host.getByTestId('pause-banner')).toBeVisible();
      await host.evaluate(() => window.scrollTo(0, 0));
      expectTeaserPlaced(await prerollGeometry(host), 'paused', phone);
      await rating.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      expectTeaserPlaced(
        await prerollGeometry(host),
        'paused, scrolled',
        phone,
      );
    } finally {
      await closeStages(stages);
    }
  });
}

interface PhoneTeaser {
  scrollY: number;
  stage: Rect;
  cards: Rect[];
  text: Record<string, Rect>;
  bar: Rect;
}

/** One synchronous read of the settled phone teaser and the action bar. */
function phoneTeaser(page: Page): Promise<PhoneTeaser> {
  return page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    const root = document.querySelector('[data-testid="linked-animation"]');
    const stage = root?.querySelector('.br-linkedset__item');
    const bar = document.querySelector('.br-table__actions');
    if (!root || !stage || !bar) {
      throw new Error('the preroll teaser is not on screen');
    }
    const text: Record<string, Rect> = {};
    for (const selector of ['.br-linked__banner', '.br-linkedset__body']) {
      const element = root.querySelector(selector);
      if (element) {
        text[selector] = rect(element);
      }
    }
    return {
      scrollY: window.scrollY,
      stage: rect(stage),
      cards: [...root.querySelectorAll('.br-linked__card')].map(rect),
      text,
      bar: rect(bar),
    };
  });
}

for (const reducedMotion of [false, true] as const) {
  test(`phone preroll teaser keeps its settled cards inside the stage and clear of the action bar (${reducedMotion ? 'reduced motion' : 'full motion'})`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stages = await openStages(browser, ['Alice', 'Bob', 'Cara'], {
      viewport: PHONE,
      locale: 'de-DE',
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
      const linked = host.getByTestId('linked-animation');
      await expect(linked).toHaveAttribute('data-variant', 'preroll', {
        timeout: 5000,
      });
      // The preroll's own settled frame: the cards landed, the line is in.
      await expect(linked.locator('.br-linked__banner')).toHaveCSS(
        'opacity',
        '1',
      );
      await expect(linked.locator('.br-linkedset__body')).toHaveCSS(
        'opacity',
        '1',
      );
      const teaser = await phoneTeaser(host);
      expect(teaser.scrollY, 'initial scroll position').toBe(0);
      expect(teaser.cards).toHaveLength(2);
      for (const card of teaser.cards) {
        expectInside(card, teaser.stage, 'settled card in the teaser stage');
      }
      // No teaser text reaches the sticky action bar.
      expect(Object.keys(teaser.text)).toHaveLength(2);
      for (const [selector, box] of Object.entries(teaser.text)) {
        expect(
          intersects(box, teaser.bar),
          `${selector} stays clear of the action bar`,
        ).toBe(false);
        expect(
          box.y + box.h,
          `${selector} ends above the action bar`,
        ).toBeLessThanOrEqual(teaser.bar.y);
      }
      // The secondary note stays in the accessibility tree, exactly once.
      const tree = await linked.ariaSnapshot();
      expect(tree.split('Namen folgen beim Reveal.').length - 1).toBe(1);
    } finally {
      await closeStages(stages);
    }
  });
}

/** Mounts the first linked reveal entry with `prepare` run before it. */
async function toLinkedReveal(
  stages: Stage[],
  prepare: (host: Page) => Promise<void>,
): Promise<Page> {
  const pages = stages.map((stage) => stage.page);
  const medias = [mediaOf(DUP), mediaOf(DUP), mediaOf(SOLO_A), mediaOf(SOLO_B)];
  await assembleRoom(stages[0]!, stages.slice(1));
  await playToPlayback(pages, medias);
  const host = pages[0]!;
  await prepare(host);
  await ratePlayback(pages, medias, TWO_OWNERS);
  await expect(
    host.getByTestId('linked-animation').getByTestId('linked-owner'),
  ).toHaveCount(2, { timeout: 15_000 });
  return host;
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test('the reveal follow-scroll leaves a focused shell control in the viewport', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara', 'Dario'], {
    viewport: DESKTOP,
    reducedMotion: 'reduce',
  });
  try {
    const host = await toLinkedReveal(stages, async (page) => {
      await page.getByTestId('sfx-toggle').focus();
    });
    const toggle = host.getByTestId('sfx-toggle');
    await expectSettled(host.getByTestId('linked-animation'));
    // No input for far longer than the two quiet seconds, and still no jump.
    await host.waitForTimeout(2500);
    expect(await scrollY(host)).toBe(0);
    await expect(toggle).toBeFocused();
    await expectInViewport(host, toggle, 'focused sfx toggle');
  } finally {
    await closeStages(stages);
  }
});

test('the reveal follow-scroll waits out recent input', async ({ browser }) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara', 'Dario'], {
    viewport: DESKTOP,
    reducedMotion: 'reduce',
  });
  try {
    const host = await toLinkedReveal(stages, async (page) => {
      // The player keeps nudging the page (wheel, key, pointer) throughout.
      await page.evaluate(() => {
        const types = ['wheel', 'keydown', 'pointerdown'];
        setInterval(() => {
          for (const type of types) {
            window.dispatchEvent(new Event(type));
          }
        }, 200);
      });
    });
    await expectSettled(host.getByTestId('linked-animation'));
    expect(await scrollY(host)).toBe(0);
  } finally {
    await closeStages(stages);
  }
});

test('an idle viewer gets the moment scrolled in once; pause and resume do not scroll again', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stages = await openStages(browser, ['Alice', 'Bob', 'Cara', 'Dario'], {
    viewport: DESKTOP,
    reducedMotion: 'no-preference',
  });
  try {
    const host = await toLinkedReveal(stages, async (page) => {
      // Nothing is focused: the page belongs to the moment.
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    });
    // The idle viewer got the moment into view (it started below the fold).
    await expect.poll(() => scrollY(host)).toBeGreaterThan(0);
    await expectInViewport(
      host,
      host.getByTestId('linked-animation').locator('.br-linked'),
      'linked stage',
    );

    // Back to the top, then a host pause and resume inside the same entry: the
    // consumed follow does not run again.
    await host.evaluate(() => window.scrollTo(0, 0));
    expect((await dispatch(host, { type: 'PAUSE' })).status).toBe('accepted');
    await expect(host.getByTestId('pause-banner')).toBeVisible();
    expect(
      (await dispatch(host, { type: 'RESUME', forceBelowMinimum: false }))
        .status,
    ).toBe('accepted');
    await expect(host.getByTestId('pause-banner')).toHaveCount(0);
    await expectSettled(host.getByTestId('linked-animation'));
    await host.waitForTimeout(500);
    expect(await scrollY(host)).toBe(0);
  } finally {
    await closeStages(stages);
  }
});
