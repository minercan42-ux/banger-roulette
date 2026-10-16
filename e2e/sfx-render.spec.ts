/**
 * Rendered-output evidence for the SPEC §6 sound effects (issue #12). Each of
 * the seven real recipes is scheduled through the production `renderEvents` on
 * an `OfflineAudioContext` and the buffer that would reach
 * `AudioDestinationNode` is measured. This is rendered output, not a listening
 * check: it shows a non-silent signal per recipe and exact silence for the off
 * control, and that a mute mid-effect silences the notes still pending. It runs
 * in every project (#19); Firefox has no `OfflineAudioContext.suspend`, so the
 * mute is applied before the render there instead of at `muteAt` - see
 * `sfx-render-probe.ts` for the measured engine difference.
 */
import { expect, test, type Page } from '@playwright/test';
import type { SfxMeasurement } from './sfx-render-probe';
import type { SfxEvent } from '../src/ui/sfx';

/** The recipes SPEC §6 asks for plus the banger moment (FR-60). */
const EVENTS: SfxEvent[] = [
  'spinTick',
  'spinStop',
  'linked',
  'revealEntry',
  'jackpot',
  'banger',
  'phaseChange',
  'final',
];

/**
 * Literal in time: the fanfare's third tone starts at +0.30 s, so muting at
 * 0.2 s has to silence both a sounding tone and two notes never started yet.
 */
const MUTE_AT_SECONDS = 0.2;
/** Peak floor for "this buffer carries a signal"; a silent buffer is exactly 0. */
const PEAK_FLOOR = 0.05;
/** Whole-window RMS floor; the shortest recipe is a 35 ms blip. */
const RMS_FLOOR = 0.002;
/** Shortest audible span; that 35 ms blip still sounds for about 20 ms. */
const SOUNDING_MS_FLOOR = 10;

/** Load the in-memory harness, then the page-side probe of the real recipes. */
async function openProbe(page: Page): Promise<void> {
  await page.goto('/');
  await page.addScriptTag({ type: 'module', url: '/e2e/sfx-render-probe.ts' });
  await page.waitForFunction(() => window.__sfxRender !== undefined);
}

function describe(event: string, measurement: SfxMeasurement): string {
  return `${event}: peak ${measurement.peak.toFixed(4)}, rms ${measurement.rms.toFixed(4)}, ${measurement.soundingMs.toFixed(1)} ms of sound`;
}

test('every production recipe renders a non-silent signal at the destination', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (events: SfxEvent[]) => {
    const probe = window.__sfxRender;
    if (!probe) {
      throw new Error('sfx render probe missing');
    }
    probe.setEnabled(true);
    const measurements: { event: SfxEvent; measurement: SfxMeasurement }[] = [];
    for (const event of events) {
      measurements.push({ event, measurement: await probe.render([event]) });
    }
    return { measurements, masterGain: probe.masterGain };
  }, EVENTS);

  console.log(
    `rendered recipes\n${result.measurements
      .map(({ event, measurement }) => describe(event, measurement))
      .join('\n')}`,
  );

  for (const { event, measurement } of result.measurements) {
    expect(measurement.peak, `${event} peak`).toBeGreaterThan(PEAK_FLOOR);
    expect(measurement.rms, `${event} rms`).toBeGreaterThan(RMS_FLOOR);
    expect(measurement.soundingMs, `${event} span`).toBeGreaterThan(
      SOUNDING_MS_FLOOR,
    );
    expect(measurement.peak, `${event} ceiling`).toBeLessThanOrEqual(
      result.masterGain + 0.001,
    );
  }
});

test('the off control renders an exactly silent buffer and plays again when on', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (events: SfxEvent[]) => {
    const probe = window.__sfxRender;
    if (!probe) {
      throw new Error('sfx render probe missing');
    }
    probe.setEnabled(false);
    const off = await probe.render(events);
    probe.setEnabled(true);
    const on = await probe.render(events);
    return { off, on };
  }, EVENTS);

  console.log(`off control: ${describe('all eight recipes', result.off)}`);
  expect(result.off.peak).toBe(0);
  expect(result.off.rms).toBe(0);
  expect(result.off.soundingMs).toBe(0);
  expect(result.on.peak).toBeGreaterThan(PEAK_FLOOR);
});

test('a mute mid-fanfare renders silence, including the pending notes', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(
    async ({ muteAt }: { muteAt: number }) => {
      const probe = window.__sfxRender;
      if (!probe) {
        throw new Error('sfx render probe missing');
      }
      probe.setEnabled(true);
      const muted = await probe.renderWithMuteAt(['final'], muteAt);
      // The toggle is on again, so the next effect has to sound again.
      const again = await probe.render(['final']);
      return { muted, again };
    },
    { muteAt: MUTE_AT_SECONDS },
  );

  console.log(
    `fanfare before ${MUTE_AT_SECONDS} s: ${describe('final', result.muted.before)}`,
  );
  console.log(
    `fanfare after ${MUTE_AT_SECONDS} s: ${describe('final', result.muted.after)}`,
  );
  console.log(`fanfare re-enabled: ${describe('final', result.again)}`);
  expect(result.muted.before.peak).toBeGreaterThan(PEAK_FLOOR);
  expect(result.muted.after.peak).toBe(0);
  expect(result.muted.after.rms).toBe(0);
  expect(result.muted.after.soundingMs).toBe(0);
  expect(result.again.peak).toBeGreaterThan(PEAK_FLOOR);
});

test('the banger recipe fills its 5 s slot: beat, finale, then silence', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async () => {
    const probe = window.__sfxRender;
    if (!probe) {
      throw new Error('sfx render probe missing');
    }
    probe.setEnabled(true);
    const ranges: [number, number][] = [
      [0, 0.3], // riser into the stamp
      [0.3, 0.45], // first kick, the stamp lands
      [1.3, 1.45], // a kick on the beat
      [3.8, 4.0], // the finale hit
      [4.0, 5.0], // the finale rings out
      [5.0, 5.5], // past the 5000 ms slot
      [0, 5.5], // the whole effect
    ];
    const measurements = await probe.renderBanger(ranges);
    probe.setEnabled(false);
    const off = await probe.renderBanger([[0, 5.5]]);
    probe.setEnabled(true);
    return { ranges, measurements, off: off[0], masterGain: probe.masterGain };
  });

  console.log(
    `banger recipe\n${result.ranges
      .map(
        (range, index) =>
          `${range[0]}-${range[1]} s: ${describe('banger', result.measurements[index]!)}`,
      )
      .join('\n')}\noff control: ${describe('banger', result.off!)}`,
  );
  const [riser, stamp, beat, finale, ringout, past] = result.measurements;
  const whole = result.measurements[6]!;
  for (const [name, measurement] of Object.entries({
    riser,
    stamp,
    beat,
    finale,
  })) {
    expect(measurement!.peak, `${name} peak`).toBeGreaterThan(PEAK_FLOOR);
    expect(measurement!.rms, `${name} rms`).toBeGreaterThan(RMS_FLOOR);
  }
  // The finale decays, but it still rings through the last second of the slot.
  expect(ringout!.peak, 'ringout peak').toBeGreaterThan(0.01);
  // The whole effect stays under the master ceiling and is loud.
  expect(whole.peak).toBeLessThanOrEqual(result.masterGain + 0.001);
  expect(whole.peak).toBeGreaterThan(0.15);
  // Nothing sounds after the slot, and the off control is exactly silent.
  expect(past!.peak).toBe(0);
  expect(result.off!.peak).toBe(0);
  expect(result.off!.rms).toBe(0);
});
