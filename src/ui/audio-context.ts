/**
 * FR-07 / SPEC §6: one shared AudioContext per tab. The explicit "Sound on"
 * click resumes it (autoplay policy), so the synthesized effects in `sfx.ts`
 * play on exactly the context that click unlocked. Browsers construct it
 * suspended, which is why nothing is audible before that click.
 */
let audioContext: AudioContext | null = null;

/**
 * The shared context only when audio is really permitted. Effects no-op on
 * anything else: a suspended context would swallow every schedule silently.
 */
export function runningAudioContext(): AudioContext | null {
  return audioContext !== null && audioContext.state === 'running'
    ? audioContext
    : null;
}

/**
 * Lazily create the shared context. A closed context is replaced, so a later
 * unlock after `releaseAudioContext()` starts from a clean slate.
 */
export function ensureAudioContext(): AudioContext {
  if (audioContext === null || audioContext.state === 'closed') {
    if (!window.AudioContext) {
      throw new Error('AudioContext unavailable');
    }
    audioContext = new window.AudioContext();
  }
  return audioContext;
}

/** Consent-click path: create the context and prove it actually runs. */
export async function unlockAudioContext(): Promise<AudioContext> {
  const context = ensureAudioContext();
  await context.resume();
  if (context.state !== 'running') {
    throw new Error('AudioContext did not resume');
  }
  return context;
}

/** Drop the shared context on room teardown; a later unlock creates a new one. */
export function releaseAudioContext(): void {
  const context = audioContext;
  audioContext = null;
  if (context !== null && context.state !== 'closed') {
    void context.close();
  }
}
