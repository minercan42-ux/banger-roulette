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
 * Give the harness page the same silent sink the other engines have built in.
 * The real context and its whole graph stay untouched: only `resume()` may
 * resolve after GRACE_MS without a browser answer, and only that context then
 * reports `running`. A browser with a working audio device settles first and is
 * never affected, so nothing is faked where the real unlock is observable.
 */
const GRACE_MS = 500;

interface SinkContext extends AudioContext {
  __silentSink?: true;
}

export function installSilentAudioSink(): void {
  const ctor = window.AudioContext;
  if (ctor === undefined) {
    return;
  }
  const prototype = ctor.prototype;
  const resume = prototype.resume as (() => Promise<void>) | undefined;
  // `state` is inherited from `BaseAudioContext`, so walk the chain for it.
  let readState: (() => AudioContextState) | undefined;
  for (
    let current: object | null = prototype;
    current !== null && readState === undefined;
    current = Object.getPrototypeOf(current)
  ) {
    readState = Object.getOwnPropertyDescriptor(current, 'state')?.get as
      (() => AudioContextState) | undefined;
  }
  if (resume === undefined || readState === undefined) {
    return;
  }

  prototype.resume = function (this: AudioContext): Promise<void> {
    const context = this as SinkContext;
    return Promise.race([
      resume.call(this),
      new Promise<void>((resolve) => {
        window.setTimeout(() => {
          context.__silentSink = true;
          resolve();
        }, GRACE_MS);
      }),
    ]);
  };

  Object.defineProperty(prototype, 'state', {
    configurable: true,
    get(this: AudioContext): AudioContextState {
      return (this as SinkContext).__silentSink === true
        ? 'running'
        : readState.call(this);
    },
  });
}
