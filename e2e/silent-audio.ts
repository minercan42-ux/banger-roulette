/**
 * Test-only silent audio sink.
 *
 * Chromium and WebKit start a hidden audio sink in a headless browser, so the
 * `AudioContext.resume()` that FR-07's consent click awaits settles and the
 * context reaches `running`. Firefox without an audio output device - a CI
 * runner, a container or headless Linux without `/dev/snd` - creates the context
 * `suspended` and then never settles `resume()` at all, so the consent click
 * stays pending forever and every scenario that needs an unlocked room hangs.
 *
 * That fallback is selected explicitly per page, never by sniffing the engine:
 * `newStage` in `e2e/m3-support.ts` sets the mode flag for the Firefox project
 * alone. Every other page keeps the native prototype, so the lifecycle a
 * scenario observes is the one the engine reports.
 *
 * Inside the selected mode the sink stays as close to the engine as possible:
 *
 * - `resume()` answers with the native result whenever the engine produces one,
 *   and the losing grace timer is cancelled then. A native settle or rejection
 *   therefore never becomes a fallback success, and nothing marks the context
 *   running 500 ms later.
 * - Only a `resume()` still pending after `GRACE_MS` resolves through the
 *   fallback, and only for that context.
 * - A later `suspend()` or `close()` clears the fallback, so the native
 *   `suspended`/`closed` lifecycle wins after activation.
 *
 * `e2e/silent-audio.spec.ts` pins all of that down behaviourally.
 */
const GRACE_MS = 500;

/** The one selectable mode: an engine whose `resume()` never settles. */
export const NO_AUDIO_DEVICE = 'no-audio-device';

declare global {
  interface Window {
    __silentAudioMode?: string;
  }
}

/** `state` is inherited from `BaseAudioContext`, so walk the chain for it. */
function findStateGetter(
  prototype: object,
): (() => AudioContextState) | undefined {
  for (
    let current: object | null = prototype;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const getter = Object.getOwnPropertyDescriptor(current, 'state')?.get as
      (() => AudioContextState) | undefined;
    if (getter !== undefined) {
      return getter;
    }
  }
  return undefined;
}

export function installSilentAudioSink(): void {
  if (window.__silentAudioMode !== NO_AUDIO_DEVICE) {
    return;
  }
  const ctor = window.AudioContext;
  if (ctor === undefined) {
    return;
  }
  const prototype = ctor.prototype;
  const nativeResume = prototype.resume;
  const nativeSuspend = prototype.suspend;
  const nativeClose = prototype.close;
  const readState = findStateGetter(prototype);
  if (
    nativeResume === undefined ||
    nativeSuspend === undefined ||
    nativeClose === undefined ||
    readState === undefined
  ) {
    return;
  }

  /** Contexts whose pending `resume()` the grace timer has resolved. */
  const fallback = new WeakSet<AudioContext>();

  prototype.resume = function (this: AudioContext): Promise<void> {
    fallback.delete(this);
    let timer: number | undefined;
    const cancelGrace = (): void => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const native = nativeResume.call(this);
    const grace = new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        timer = undefined;
        fallback.add(this);
        resolve();
      }, GRACE_MS);
    });
    return Promise.race([native, grace]).then(
      (value) => {
        cancelGrace();
        return value;
      },
      (error: unknown) => {
        cancelGrace();
        throw error;
      },
    );
  };

  prototype.suspend = function (this: AudioContext): Promise<void> {
    fallback.delete(this);
    return nativeSuspend.call(this);
  };

  prototype.close = function (this: AudioContext): Promise<void> {
    fallback.delete(this);
    return nativeClose.call(this);
  };

  Object.defineProperty(prototype, 'state', {
    configurable: true,
    get(this: AudioContext): AudioContextState {
      const native = readState.call(this);
      return native === 'suspended' && fallback.has(this) ? 'running' : native;
    },
  });
}
