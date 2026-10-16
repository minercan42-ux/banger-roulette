import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '../net/session';
import { releaseAudioContext, unlockAudioContext } from './audio-context';

export interface SoundUnlock {
  /** This tab's AudioContext runs and the shared flag agrees (FR-07). */
  soundReady: boolean;
  busy: boolean;
  errorKey: string | null;
  enable: () => Promise<void>;
}

/**
 * FR-07 local audio unlock, owned by the room view so it lives exactly as long
 * as the room does. The consent control moves between layout slots (stage in
 * the lobby, drawer afterwards); the unlock state and the shared AudioContext
 * must survive that, so neither lives in the control component. The consent
 * click really resumes an AudioContext and only then reports SOUND_STATUS: it
 * proves the browser permits audio, not YouTube autoplay (only an actual
 * PLAYING event does that, M4 player). Any failure resets to `false`.
 */
export function useSoundUnlock(
  session: GameSession,
  canWrite: boolean,
  unlocked: boolean,
): SoundUnlock {
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [locallyUnlocked, setLocallyUnlocked] = useState(false);
  const resetInFlight = useRef(false);
  const soundReady = locallyUnlocked && unlocked;

  // A retained actor's old flag is not proof of this tab's audio permission.
  useEffect(() => {
    if (!canWrite || !unlocked || locallyUnlocked || resetInFlight.current) {
      return;
    }
    resetInFlight.current = true;
    void session
      .dispatch({ type: 'SOUND_STATUS', unlocked: false })
      .finally(() => {
        resetInFlight.current = false;
      });
  }, [canWrite, unlocked, locallyUnlocked, session]);

  // Leaving the room drops the shared context the sfx director plays on; a
  // later consent click in the next room creates a fresh one.
  useEffect(() => () => releaseAudioContext(), []);

  async function enable() {
    if (busy || !canWrite || soundReady) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await unlockAudioContext();
      setLocallyUnlocked(true);
      const result = await session.dispatch({
        type: 'SOUND_STATUS',
        unlocked: true,
      });
      if (result.status === 'rejected') {
        setErrorKey(`errors.${result.reason}`);
      }
    } catch {
      setLocallyUnlocked(false);
      setErrorKey('sound.failed');
      if (canWrite) {
        await session
          .dispatch({ type: 'SOUND_STATUS', unlocked: false })
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return { soundReady, busy, errorKey, enable };
}
