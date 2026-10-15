import { runningAudioContext } from './audio-context';
import { useSfxStore } from './sfx-store';

/**
 * SPEC §6: subtle casino effects, synthesized with the Web Audio API so no
 * audio asset has to be shipped. Every name is one recipe below.
 */
export type SfxEvent =
  | 'spinTick'
  | 'spinStop'
  | 'linked'
  | 'revealEntry'
  | 'jackpot'
  | 'phaseChange'
  | 'final';

/**
 * Hard ceiling of the effect bus. Every recipe is routed through one gain node
 * set to exactly this value, so no event can ever be louder than 0.2.
 */
export const MASTER_GAIN = 0.2;

/** Attack of every envelope: long enough against clicks, short against smear. */
const ATTACK_SECONDS = 0.008;
/** Exponential ramps cannot reach zero; this is the fade-out floor. */
const SILENCE = 0.0001;

interface Tone {
  frequency: number;
  type: OscillatorType;
  /** Offset from the effect start, in seconds. */
  at: number;
  duration: number;
  /** Peak gain of the tone before the master ceiling. */
  gain: number;
  /** Optional exponential glide that lands at the tone's end. */
  sweepTo?: number;
}

/** Short blip per wheel segment the pointer passes (FR-10). */
const SPIN_TICK: Tone[] = [
  { frequency: 1240, type: 'square', at: 0, duration: 0.035, gain: 0.5 },
];

/** The wheel settles: a falling sweep plus a low thud. */
const SPIN_STOP: Tone[] = [
  {
    frequency: 900,
    type: 'sawtooth',
    at: 0,
    duration: 0.35,
    gain: 0.7,
    sweepTo: 170,
  },
  { frequency: 130, type: 'sine', at: 0.3, duration: 0.28, gain: 0.9 },
];

/** FR-26 "Spiritually Linked": a rising two-note sparkle. */
const LINKED: Tone[] = [
  { frequency: 659.25, type: 'sine', at: 0, duration: 0.14, gain: 0.7 },
  { frequency: 987.77, type: 'sine', at: 0.11, duration: 0.2, gain: 0.7 },
];

/** One entry of the reveal walks up into view (FR-60). */
const REVEAL_ENTRY: Tone[] = [
  {
    frequency: 523.25,
    type: 'triangle',
    at: 0,
    duration: 0.16,
    gain: 0.7,
    sweepTo: 783.99,
  },
];

/** The round winner's jackpot animation (FR-60): a four-step arpeggio. */
const JACKPOT: Tone[] = [
  { frequency: 523.25, type: 'sine', at: 0, duration: 0.12, gain: 0.75 },
  { frequency: 659.25, type: 'sine', at: 0.09, duration: 0.12, gain: 0.75 },
  { frequency: 783.99, type: 'sine', at: 0.18, duration: 0.12, gain: 0.75 },
  { frequency: 1046.5, type: 'sine', at: 0.27, duration: 0.45, gain: 0.9 },
];

/** Any phase boundary (SPEC §4). */
const PHASE_CHANGE: Tone[] = [
  {
    frequency: 440,
    type: 'sine',
    at: 0,
    duration: 0.14,
    gain: 0.55,
    sweepTo: 660,
  },
];

/** The finale fanfare (FR-62), held one beat longer than the jackpot. */
const FINAL: Tone[] = [
  { frequency: 523.25, type: 'triangle', at: 0, duration: 0.16, gain: 0.75 },
  { frequency: 659.25, type: 'triangle', at: 0.15, duration: 0.16, gain: 0.75 },
  { frequency: 783.99, type: 'triangle', at: 0.3, duration: 0.16, gain: 0.75 },
  { frequency: 1046.5, type: 'triangle', at: 0.45, duration: 0.7, gain: 0.9 },
];

const RECIPES: Record<SfxEvent, Tone[]> = {
  spinTick: SPIN_TICK,
  spinStop: SPIN_STOP,
  linked: LINKED,
  revealEntry: REVEAL_ENTRY,
  jackpot: JACKPOT,
  phaseChange: PHASE_CHANGE,
  final: FINAL,
};

/** Schedule one recipe on one already-running context. */
function schedule(context: AudioContext, tones: Tone[]): void {
  const start = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(MASTER_GAIN, start);
  master.connect(context.destination);
  let last: OscillatorNode | null = null;
  for (const tone of tones) {
    const begin = start + tone.at;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.frequency, begin);
    if (tone.sweepTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        tone.sweepTo,
        begin + tone.duration,
      );
    }
    envelope.gain.setValueAtTime(0, begin);
    envelope.gain.linearRampToValueAtTime(
      tone.gain,
      begin + Math.min(ATTACK_SECONDS, tone.duration / 2),
    );
    envelope.gain.exponentialRampToValueAtTime(SILENCE, begin + tone.duration);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(begin);
    oscillator.stop(begin + tone.duration + 0.02);
    last = oscillator;
  }
  // The bus is per effect, so it is dropped with its last tone instead of
  // piling up gain nodes on the shared context.
  if (last !== null) {
    last.onended = () => {
      master.disconnect();
    };
  }
}

/**
 * Play a batch of effects. Silent no-op while the toggle is off (the flag is
 * read per call, never captured) and before the local sound unlock created a
 * running context: a suspended context would swallow the schedule anyway.
 */
export function playEvents(events: SfxEvent[]): void {
  const context = runningAudioContext();
  if (events.length === 0 || context === null) {
    return;
  }
  if (!useSfxStore.getState().enabled) {
    return;
  }
  for (const event of events) {
    schedule(context, RECIPES[event]);
  }
}
