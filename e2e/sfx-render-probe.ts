/**
 * Test-only page-side probe for `e2e/sfx-render.spec.ts`. It exposes the real
 * recipes and the real toggle of `src/ui/*` to the spec and renders them
 * through an `OfflineAudioContext`, so the spec can measure the buffer that
 * would reach `AudioDestinationNode`. Nothing here is part of the production
 * build: the app reaches the same code through `playEvents` only.
 */
import { MASTER_GAIN, renderEvents, type SfxEvent } from '../src/ui/sfx';
import { useSfxStore } from '../src/ui/sfx-store';

/** Render window in seconds; the longest recipe (the finale) ends at 1.15 s. */
const WINDOW_SECONDS = 1.5;
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
  /** Render a batch and switch the toggle off `muteAt` seconds into the render. */
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

async function renderWithMuteAt(
  events: SfxEvent[],
  muteAt: number,
): Promise<{ before: SfxMeasurement; after: SfxMeasurement }> {
  const context = createContext();
  renderEvents(context, events);
  const muted = context.suspend(muteAt).then(() => {
    useSfxStore.setState({ enabled: false });
    return context.resume();
  });
  const buffer = await context.startRendering();
  await muted;
  useSfxStore.setState({ enabled: true });
  const data = buffer.getChannelData(0);
  return {
    before: measure(data, 0, muteAt),
    after: measure(data, muteAt + MUTE_SETTLE_SECONDS, WINDOW_SECONDS),
  };
}

window.__sfxRender = {
  masterGain: MASTER_GAIN,
  setEnabled: (enabled) => {
    useSfxStore.setState({ enabled });
  },
  render,
  renderWithMuteAt,
};
