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
  | 'banger'
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
/** Fade applied when the toggle silences an effect that is still sounding. */
const MUTE_FADE_SECONDS = 0.01;

export interface Tone {
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

/**
 * FR-26 "Spiritually Linked", timed to the moment in `LinkedAnimation`: a rising
 * whoosh while the owner cards fly in, a low thud and a bright chime at the
 * collision (+0.7 s), three chain clinks as the cards clamp together. Well
 * inside the 2.5 s reveal slot; it only plays where no show brings its own
 * sound (see `SfxDirector`).
 */
const LINKED: Tone[] = [
  {
    frequency: 220,
    type: 'sawtooth',
    at: 0,
    duration: 0.68,
    gain: 0.16,
    sweepTo: 880,
  },
  {
    frequency: 150,
    type: 'sine',
    at: 0.7,
    duration: 0.24,
    gain: 0.55,
    sweepTo: 60,
  },
  { frequency: 659.25, type: 'sine', at: 0.72, duration: 0.3, gain: 0.4 },
  { frequency: 987.77, type: 'sine', at: 0.8, duration: 0.3, gain: 0.4 },
  { frequency: 1318.5, type: 'triangle', at: 0.88, duration: 0.5, gain: 0.35 },
  { frequency: 2637, type: 'square', at: 0.78, duration: 0.04, gain: 0.1 },
  { frequency: 2637, type: 'square', at: 0.86, duration: 0.04, gain: 0.1 },
  { frequency: 2637, type: 'square', at: 0.94, duration: 0.04, gain: 0.1 },
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

/**
 * "THIS IS A BANGER" (a 10.0 song): five seconds, exactly the engine's banger
 * reveal slot, at 120 bpm with the first kick on the stamp. An air-horn scoop
 * and chord, a kick on every beat, a backbeat snare and a snare roll into the
 * finale, a rising two-octave arpeggio and a last hit at +3.8 s that rings out
 * before the slot ends. The layers are written with a headroom of 1 and then
 * made up by `BANGER_BOOST`: their peaks never line up and the envelopes decay,
 * so the rendered peak stays under the 0.2 master ceiling, which
 * `e2e/sfx-render.spec.ts` measures over the whole effect.
 * Oscillators only: the snare is a pitched body plus a fast square sweep.
 */
const BANGER_BEAT_SECONDS = 0.5;
/** Make-up gain of the layered effect, so the owner's moment is the loudest. */
export const BANGER_BOOST = 1.5;
/** First kick: the stamp lands 0.3 s into the show. */
const BANGER_FIRST_HIT = 0.3;
/** The last hit: confetti burst and last shake of the show. */
const BANGER_FINALE_AT = 3.8;

function kick(at: number, gain: number, duration = 0.22): Tone {
  return {
    frequency: 160,
    type: 'sine',
    at,
    duration,
    gain,
    sweepTo: 42,
  };
}

function snare(at: number): Tone[] {
  return [
    {
      frequency: 330,
      type: 'triangle',
      at,
      duration: 0.12,
      gain: 0.17,
      sweepTo: 180,
    },
    {
      frequency: 2400,
      type: 'square',
      at,
      duration: 0.09,
      gain: 0.1,
      sweepTo: 900,
    },
  ];
}

function bangerTones(): Tone[] {
  const tones: Tone[] = [
    // Riser into the stamp.
    {
      frequency: 120,
      type: 'sawtooth',
      at: 0,
      duration: BANGER_FIRST_HIT,
      gain: 0.25,
      sweepTo: 900,
    },
    // Air horn: the scoop up, then the held triad.
    {
      frequency: 180,
      type: 'sawtooth',
      at: 0.22,
      duration: 0.16,
      gain: 0.12,
      sweepTo: 440,
    },
    { frequency: 440, type: 'sawtooth', at: 0.36, duration: 1, gain: 0.08 },
    { frequency: 554.37, type: 'sawtooth', at: 0.36, duration: 1, gain: 0.08 },
    { frequency: 659.25, type: 'sawtooth', at: 0.36, duration: 1, gain: 0.08 },
  ];
  // A kick on every beat up to the finale.
  for (
    let at = BANGER_FIRST_HIT;
    at < BANGER_FINALE_AT - 0.01;
    at += BANGER_BEAT_SECONDS
  ) {
    tones.push(kick(at, 0.34));
  }
  // Backbeat snare, then a roll of 16ths that builds into the finale.
  for (const at of [0.8, 1.8, 2.8]) {
    tones.push(...snare(at));
  }
  for (const at of [3.3, 3.425, 3.55, 3.675]) {
    tones.push(...snare(at));
  }
  // Rising major arpeggio, C5 up over two and a half octaves.
  const steps = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36, 40, 43];
  steps.forEach((step, index) => {
    tones.push({
      frequency: 523.25 * 2 ** (step / 12),
      type: 'square',
      at: 0.9 + index * 0.2,
      duration: 0.22,
      gain: 0.12,
    });
  });
  // The last hit, ringing out until 4.8 s. The chord is the last tone to end.
  tones.push(
    kick(BANGER_FINALE_AT, 0.3, 0.5),
    {
      frequency: 55,
      type: 'sine',
      at: BANGER_FINALE_AT,
      duration: 0.9,
      gain: 0.1,
    },
    {
      frequency: 3100,
      type: 'square',
      at: BANGER_FINALE_AT,
      duration: 0.8,
      gain: 0.06,
      sweepTo: 1500,
    },
    {
      frequency: 4300,
      type: 'square',
      at: BANGER_FINALE_AT,
      duration: 0.8,
      gain: 0.06,
      sweepTo: 1900,
    },
    {
      frequency: 523.25,
      type: 'sawtooth',
      at: BANGER_FINALE_AT,
      duration: 1,
      gain: 0.1,
    },
    {
      frequency: 659.25,
      type: 'sawtooth',
      at: BANGER_FINALE_AT,
      duration: 1,
      gain: 0.1,
    },
    {
      frequency: 783.99,
      type: 'sawtooth',
      at: BANGER_FINALE_AT,
      duration: 1,
      gain: 0.1,
    },
    {
      frequency: 1046.5,
      type: 'sawtooth',
      at: BANGER_FINALE_AT,
      duration: 1,
      gain: 0.1,
    },
  );
  return tones.map((tone) => ({ ...tone, gain: tone.gain * BANGER_BOOST }));
}

const BANGER: Tone[] = bangerTones();

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
  banger: BANGER,
  phaseChange: PHASE_CHANGE,
  final: FINAL,
};

/** The tones of one recipe, for the specs that pin its timing and loudness. */
export function recipeTones(event: SfxEvent): readonly Tone[] {
  return RECIPES[event];
}

/**
 * One effect bus: the master gain of a single effect plus every oscillator
 * feeding it. A bus is registered while it sounds, so the toggle can silence it
 * after the fact; the last tone's `onended` unregisters it again.
 */
interface EffectBus {
  master: GainNode;
  sources: OscillatorNode[];
}

/** Buses that are sounding right now. */
const activeBuses = new Set<EffectBus>();

/**
 * SPEC §6 "abschaltbar": switching the toggle off silences what is already
 * playing, not only the next call. Every active bus is faded to zero, so tones
 * scheduled for later in a multi-note effect cannot start after the button says
 * "off". The shared context is untouched: switching back on plays on the same
 * unlocked context.
 *
 * A bus master never leaves MASTER_GAIN before its mute (the envelopes live on
 * the per-tone gains), so each ramp restarts from that known value instead of
 * reading a running automation.
 */
function silenceActiveBuses(): void {
  const buses = [...activeBuses];
  activeBuses.clear();
  for (const bus of buses) {
    const now = bus.master.context.currentTime;
    bus.master.gain.cancelScheduledValues(now);
    bus.master.gain.setValueAtTime(MASTER_GAIN, now);
    bus.master.gain.linearRampToValueAtTime(0, now + MUTE_FADE_SECONDS);
  }
}

useSfxStore.subscribe((state, previous) => {
  if (previous.enabled && !state.enabled) {
    silenceActiveBuses();
  }
});

/** Schedule one recipe into a fresh bus on `context` and return that bus. */
function scheduleBus(context: BaseAudioContext, tones: Tone[]): EffectBus {
  const start = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(MASTER_GAIN, start);
  master.connect(context.destination);
  const sources: OscillatorNode[] = [];
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
    sources.push(oscillator);
  }
  const bus: EffectBus = { master, sources };
  const last = sources[sources.length - 1];
  // The bus is per effect, so it is dropped with its last tone instead of
  // piling up gain nodes on the shared context.
  if (last !== undefined) {
    last.onended = () => {
      activeBuses.delete(bus);
      master.disconnect();
    };
  }
  return bus;
}

/** The one gate every path shares: nothing is scheduled while the toggle is off. */
function playOn(context: BaseAudioContext, events: SfxEvent[]): void {
  if (events.length === 0 || !useSfxStore.getState().enabled) {
    return;
  }
  for (const event of events) {
    activeBuses.add(scheduleBus(context, RECIPES[event]));
  }
}

/**
 * Play a batch of effects. Silent no-op while the toggle is off (the flag is
 * read per call, never captured) and before the local sound unlock created a
 * running context: a suspended context would swallow the schedule anyway.
 */
export function playEvents(events: SfxEvent[]): void {
  const context = runningAudioContext();
  if (context === null) {
    return;
  }
  playOn(context, events);
}

/**
 * Schedule a batch on an arbitrary context through exactly the production path
 * (`playOn`, toggle included). Split out so the rendered-output evidence
 * (`e2e/sfx-render.spec.ts`) can measure the real recipes on an
 * `OfflineAudioContext`; the app itself only ever reaches `playEvents`.
 */
export function renderEvents(
  context: BaseAudioContext,
  events: SfxEvent[],
): void {
  playOn(context, events);
}
