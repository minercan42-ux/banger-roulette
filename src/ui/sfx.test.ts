import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ensureAudioContext,
  releaseAudioContext,
  unlockAudioContext,
} from './audio-context';
import {
  BANGER_BOOST,
  MASTER_GAIN,
  playEvents,
  recipeTones,
  type SfxEvent,
} from './sfx';
import { useSfxStore } from './sfx-store';

const ALL_EVENTS: SfxEvent[] = [
  'spinTick',
  'spinStop',
  'linked',
  'revealEntry',
  'jackpot',
  'banger',
  'phaseChange',
  'final',
];

interface ParamCall {
  method: string;
  value?: number;
  time: number;
}

class FakeParam {
  value = 0;
  readonly calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.calls.push({ method: 'setValueAtTime', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.calls.push({ method: 'linearRampToValueAtTime', value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.calls.push({ method: 'exponentialRampToValueAtTime', value, time });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.calls.push({ method: 'cancelScheduledValues', time });
    return this;
  }
}

class FakeGain {
  gain = new FakeParam();
  readonly targets: unknown[] = [];
  disconnected = false;
  constructor(readonly context: FakeAudioContext) {}
  connect(target: unknown) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeOscillator {
  type = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  readonly targets: unknown[] = [];
  /** Every `stop(when)` the scheduler issued, so mutes stay observable. */
  readonly stops: number[] = [];
  start() {}
  stop(when: number) {
    this.stops.push(when);
  }
  connect(target: unknown) {
    this.targets.push(target);
  }
}

/** Every context `window.AudioContext` handed out, oldest first. */
const created: FakeAudioContext[] = [];

class FakeAudioContext {
  state = 'suspended';
  currentTime = 0;
  readonly destination = {};
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];

  constructor() {
    created.push(this);
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
  createGain() {
    const node = new FakeGain(this);
    this.gains.push(node);
    return node;
  }
  createOscillator() {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
}

function lastContext(): FakeAudioContext {
  const context = created[created.length - 1];
  if (context === undefined) {
    throw new Error('no AudioContext was created');
  }
  return context;
}

/** Every effect bus on a context: one master per effect, plus tone envelopes. */
function masterGains(context: FakeAudioContext): FakeGain[] {
  return context.gains.filter((gain) =>
    gain.targets.includes(context.destination),
  );
}

function soleMasterGain(context: FakeAudioContext): FakeGain {
  const masters = masterGains(context);
  if (masters.length !== 1) {
    throw new Error(`expected one effect bus, found ${masters.length}`);
  }
  return masters[0];
}

beforeEach(() => {
  // The module registry survives across tests in one process, so drop the buses
  // a previous test left sounding through the public toggle before starting.
  useSfxStore.setState({ enabled: false });
  releaseAudioContext();
  created.length = 0;
  useSfxStore.setState({ enabled: true });
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
});

afterEach(() => {
  releaseAudioContext();
  vi.unstubAllGlobals();
});

test('every recipe schedules its tones on the unlocked context', async () => {
  await unlockAudioContext();
  const context = lastContext();
  for (const event of ALL_EVENTS) {
    const before = context.oscillators.length;
    playEvents([event]);
    expect(context.oscillators.length).toBeGreaterThan(before);
    expect(
      context.oscillators
        .slice(before)
        .every((oscillator) => oscillator.targets.length === 1),
    ).toBe(true);
  }
});

test('every recipe routes through the master gain ceiling', async () => {
  await unlockAudioContext();
  const context = lastContext();
  expect(MASTER_GAIN).toBeLessThanOrEqual(0.2);
  for (const event of ALL_EVENTS) {
    const before = context.gains.length;
    playEvents([event]);
    const master = context.gains[before];
    expect(master.gain.value).toBe(MASTER_GAIN);
    expect(master.targets).toEqual([context.destination]);
  }
});

test('the toggle off creates no audio nodes at all', async () => {
  await unlockAudioContext();
  useSfxStore.setState({ enabled: false });
  playEvents(ALL_EVENTS);
  const context = lastContext();
  expect(context.oscillators).toHaveLength(0);
  expect(context.gains).toHaveLength(0);
});

test('switching the toggle back on schedules again', async () => {
  await unlockAudioContext();
  useSfxStore.setState({ enabled: false });
  playEvents(['jackpot']);
  expect(lastContext().oscillators).toHaveLength(0);
  useSfxStore.setState({ enabled: true });
  playEvents(['jackpot']);
  expect(lastContext().oscillators).toHaveLength(4);
});

test('switching the toggle off fades an effect that is still sounding', async () => {
  await unlockAudioContext();
  playEvents(['final']);
  const context = lastContext();
  const master = soleMasterGain(context);
  expect(master.gain.value).toBe(MASTER_GAIN);
  useSfxStore.setState({ enabled: false });
  expect(master.gain.calls.map((call) => call.method)).toEqual([
    'setValueAtTime',
    'cancelScheduledValues',
    'setValueAtTime',
    'linearRampToValueAtTime',
  ]);
  expect(master.gain.calls[2]).toMatchObject({
    value: MASTER_GAIN,
    time: context.currentTime,
  });
  const ramp = master.gain.calls[3];
  expect(ramp).toMatchObject({ value: 0 });
  expect(ramp.time).toBeGreaterThan(0);
  expect(ramp.time).toBeLessThanOrEqual(0.05);
  expect(master.gain.value).toBe(0);
  // The shared context survives the mute: switching back on plays on it again.
  expect(context.state).toBe('running');
});

test('the notes a muted fanfare had pending stay silent', async () => {
  await unlockAudioContext();
  playEvents(['final']);
  const context = lastContext();
  const master = soleMasterGain(context);
  // The fanfare's last tone is scheduled at +0.45 s, so muting the bus at 0 s
  // has to silence notes that have not started yet.
  useSfxStore.setState({ enabled: false });
  expect(master.gain.value).toBe(0);
  useSfxStore.setState({ enabled: true });
  playEvents(['final']);
  const masters = masterGains(context);
  expect(masters).toHaveLength(2);
  expect(masters[1].gain.value).toBe(MASTER_GAIN);
  expect(context.oscillators).toHaveLength(8);
});

test('nothing plays before a context exists', () => {
  playEvents(ALL_EVENTS);
  expect(created).toHaveLength(0);
});

test('a suspended context stays silent until the consent click', async () => {
  ensureAudioContext();
  const context = lastContext();
  playEvents(ALL_EVENTS);
  expect(context.oscillators).toHaveLength(0);
  await unlockAudioContext();
  playEvents(['linked']);
  expect(context.oscillators.length).toBeGreaterThan(0);
});

test('the release closes the shared context', async () => {
  await unlockAudioContext();
  const context = lastContext();
  releaseAudioContext();
  expect(context.state).toBe('closed');
  playEvents(ALL_EVENTS);
  expect(created).toEqual([context]);
  expect(context.oscillators).toHaveLength(0);
});

test('the banger recipe fits the engine banger slot and the master ceiling', () => {
  const tones = recipeTones('banger');
  // 5000 ms is the engine's BANGER_REVEAL_MS; the show ends with the slot.
  const end = Math.max(...tones.map((tone) => tone.at + tone.duration));
  expect(end).toBeLessThanOrEqual(5);
  expect(end).toBeGreaterThan(4.5);
  // The bus calls `onended` of the last tone to drop itself: that tone has to
  // be the one that ends last.
  const last = tones[tones.length - 1];
  expect(last.at + last.duration).toBe(end);
  // Upper bound of the envelopes at every instant: a tone counts with its peak
  // gain while it sounds. The layers are written for a sum <= 1 and made up by
  // the boost; the rendered peak itself is measured in e2e/sfx-render.spec.ts.
  const instants = tones.flatMap((tone) => [tone.at, tone.at + 0.001]);
  for (const instant of instants) {
    const sum = tones
      .filter((tone) => instant >= tone.at && instant < tone.at + tone.duration)
      .reduce((total, tone) => total + tone.gain, 0);
    expect(sum, `layers at ${instant.toFixed(3)} s`).toBeLessThanOrEqual(
      BANGER_BOOST + 1e-9,
    );
  }
  // The beat: a kick lands on the stamp (0.3 s) and the finale (3.8 s).
  const kicks = tones.filter(
    (tone) => tone.type === 'sine' && tone.sweepTo === 42,
  );
  expect(kicks.map((tone) => tone.at)).toContain(0.3);
  expect(kicks.map((tone) => tone.at)).toContain(3.8);
});

test('the banger recipe is silent with the toggle off', async () => {
  await unlockAudioContext();
  useSfxStore.setState({ enabled: false });
  playEvents(['banger']);
  expect(lastContext().oscillators).toHaveLength(0);
  expect(lastContext().gains).toHaveLength(0);
});
