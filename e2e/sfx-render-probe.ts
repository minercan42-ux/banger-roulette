/**
 * Test-only page-side probe for `e2e/sfx-render.spec.ts`. It exposes the real
 * recipes and the real toggle of `src/ui/*` to the spec and renders them
 * through an `OfflineAudioContext`, so the spec can measure the buffer that
 * would reach `AudioDestinationNode`. Nothing here is part of the production
 * build: the app reaches the same code through `playEvents` only.
 */
import { MASTER_GAIN, renderEvents, type SfxEvent } from '../src/ui/sfx';
import { useSfxStore } from '../src/ui/sfx-store';

/** Render window in seconds; the longest short recipe (the finale) ends at 1.15 s. */
const WINDOW_SECONDS = 1.5;
/** Window of the banger recipe, which fills the 5 s banger reveal slot. */
const BANGER_WINDOW_SECONDS = 5.5;
/** Extra window after a mute so the 10 ms fade is fully inside the "after" range. */
const MUTE_SETTLE_SECONDS = 0.05;
/** Sample rate of every render. */
const SAMPLE_RATE = 44_100;
/** A sample above this counts as sound when the audible span is measured. */
const SOUND_EPSILON = 0.001;

export interface SfxMeasurement {
  /** Largest absolute sample in the measured range. */
  peak: number;
  /** Root mean square over the measured range. */
  rms: number;
  /** Length of the part of the range whose samples stay above the epsilon. */
  soundingMs: number;
}

export interface SfxRenderProbe {
  /** The production ceiling every recipe is routed through. */
  readonly masterGain: number;
  /** Flip the in-memory toggle exactly like the header button does. */
  setEnabled(enabled: boolean): void;
  /** Render one batch with the toggle as it currently stands. */
  render(events: SfxEvent[]): Promise<SfxMeasurement>;
  /**
   * Render the banger recipe alone over its 5 s slot (plus a 0.5 s tail) and
   * measure each `[from, to]` second range of that one buffer.
   */
  renderBanger(ranges: [number, number][]): Promise<SfxMeasurement[]>;
  /**
   * Render a batch with the toggle switched off `muteAt` seconds in, and
   * measure the buffer before and after that switch. Engines without
   * `OfflineAudioContext.suspend` mute right before the render starts instead;
   * see the implementation for why the measured property is the same.
   */
  renderWithMuteAt(
    events: SfxEvent[],
    muteAt: number,
  ): Promise<{ before: SfxMeasurement; after: SfxMeasurement }>;
}

declare global {
  interface Window {
    __sfxRender?: SfxRenderProbe;
  }
}

function createContext(): OfflineAudioContext {
  return new OfflineAudioContext(
    1,
    Math.ceil(WINDOW_SECONDS * SAMPLE_RATE),
    SAMPLE_RATE,
  );
}

function measure(
  data: Float32Array,
  fromSeconds: number,
  toSeconds: number,
): SfxMeasurement {
  const from = Math.max(0, Math.floor(fromSeconds * SAMPLE_RATE));
  const to = Math.min(data.length, Math.ceil(toSeconds * SAMPLE_RATE));
  let peak = 0;
  let sum = 0;
  let sounding = 0;
  for (let index = from; index < to; index += 1) {
    const sample = Math.abs(data[index]);
    if (sample > peak) {
      peak = sample;
    }
    sum += data[index] * data[index];
    if (sample > SOUND_EPSILON) {
      sounding += 1;
    }
  }
  return {
    peak,
    rms: Math.sqrt(sum / Math.max(1, to - from)),
    soundingMs: (sounding / SAMPLE_RATE) * 1000,
  };
}

async function render(events: SfxEvent[]): Promise<SfxMeasurement> {
  const context = createContext();
  renderEvents(context, events);
  const buffer = await context.startRendering();
  return measure(buffer.getChannelData(0), 0, WINDOW_SECONDS);
}

async function renderBanger(
  ranges: [number, number][],
): Promise<SfxMeasurement[]> {
  const context = new OfflineAudioContext(
    1,
    Math.ceil(BANGER_WINDOW_SECONDS * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  renderEvents(context, ['banger']);
  const data = (await context.startRendering()).getChannelData(0);
  return ranges.map(([from, to]) => measure(data, from, to));
}

/** Flips the in-memory toggle exactly like the header button does. */
function muteBus(): void {
  useSfxStore.setState({ enabled: false });
}

/**
 * Renders `events` with the toggle switched off `muteAt` seconds into the
 * render and measures the buffer before and after that switch.
 *
 * `OfflineAudioContext.suspend()` is the only way to interleave the switch with
 * a running render, and Firefox does not implement it
 * (`typeof OfflineAudioContext.prototype.suspend === 'undefined'`, measured in
 * Firefox 1555; bugzil.la/1265406 is still open, so MDN marks the method "not
 * Baseline"). Firefox therefore switches the toggle off right after the batch
 * was scheduled and before the render starts: the production fade - the very
 * `silenceActiveBuses` the header button triggers - then runs from sample zero,
 * and the measured "after" window still proves the property under test, that no
 * tone of a muted bus ever reaches the destination, not even the notes this
 * recipe schedules for later. The "before" window of that path comes from the
 * same recipe rendered once with the toggle on, because a render that was muted
 * from the start is already silent after its 10 ms fade.
 */
async function renderWithMuteAt(
  events: SfxEvent[],
  muteAt: number,
): Promise<{ before: SfxMeasurement; after: SfxMeasurement }> {
  const context = createContext();
  renderEvents(context, events);
  if (typeof context.suspend === 'function') {
    const muted = context.suspend(muteAt).then(() => {
      muteBus();
      return context.resume();
    });
    const buffer = await context.startRendering();
    await muted;
    // The toggle is on again, so the next effect has to sound again.
    useSfxStore.setState({ enabled: true });
    const data = buffer.getChannelData(0);
    return {
      before: measure(data, 0, muteAt),
      after: measure(data, muteAt + MUTE_SETTLE_SECONDS, WINDOW_SECONDS),
    };
  }

  muteBus();
  const mutedBuffer = await context.startRendering();
  useSfxStore.setState({ enabled: true });
  const sounding = createContext();
  renderEvents(sounding, events);
  const soundingBuffer = await sounding.startRendering();
  return {
    before: measure(soundingBuffer.getChannelData(0), 0, muteAt),
    after: measure(
      mutedBuffer.getChannelData(0),
      muteAt + MUTE_SETTLE_SECONDS,
      WINDOW_SECONDS,
    ),
  };
}

window.__sfxRender = {
  masterGain: MASTER_GAIN,
  setEnabled: (enabled) => {
    useSfxStore.setState({ enabled });
  },
  render,
  renderBanger,
  renderWithMuteAt,
};
