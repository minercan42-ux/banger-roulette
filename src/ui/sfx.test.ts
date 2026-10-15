import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ensureAudioContext,
  releaseAudioContext,
  unlockAudioContext,
} from './audio-context';
import { MASTER_GAIN, playEvents, type SfxEvent } from './sfx';
import { useSfxStore } from './sfx-store';

const ALL_EVENTS: SfxEvent[] = [
  'spinTick',
  'spinStop',
  'linked',
  'revealEntry',
  'jackpot',
  'phaseChange',
  'final',
];

class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
}

class FakeGain {
  gain = new FakeParam();
  readonly targets: unknown[] = [];
  disconnected = false;
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
  start() {}
  stop() {}
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
    const node = new FakeGain();
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

beforeEach(() => {
  releaseAudioContext();
  created.length = 0;
  useSfxStore.setState({ enabled: true });
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
});

afterEach(() => {
  releaseAudioContext();
  vi.unstubAllGlobals();
});

test('every recipe schedules audible nodes on the unlocked context', async () => {
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
