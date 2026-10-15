/**
 * Rendered-output evidence for the SPEC §6 sound effects (issue #12). Each of
 * the seven real recipes is scheduled through the production `renderEvents` on
 * an `OfflineAudioContext` in Chromium and the buffer that would reach
 * `AudioDestinationNode` is measured. This is rendered output, not a listening
 * check: it shows a non-silent signal per recipe and exact silence for the off
 * control, and that a mute mid-effect silences the notes still pending.
 */
import { expect, test, type Page } from '@playwright/test';
import type { SfxMeasurement } from './sfx-render-probe';
import type { SfxEvent } from '../src/ui/sfx';

/** The seven recipes SPEC §6 asks for. */
const EVENTS: SfxEvent[] = [
  'spinTick',
  'spinStop',
  'linked',
  'revealEntry',
  'jackpot',
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

  console.log(`off control: ${describe('all seven recipes', result.off)}`);
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
