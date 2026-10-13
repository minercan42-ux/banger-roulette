import { useEffect, useState } from 'react';
import type { GameSession } from '../net/session';

/**
 * Server-synced "now" for phase math (SPEC §3: deadlines are absolute server
 * time). While `active` the value refreshes on the animation frame clock so
 * deadline-derived animations stay smooth; otherwise it stays put and the view
 * only re-renders when React re-renders for another reason.
 */
export function useSessionNow(
  session: GameSession,
  active: boolean,
  frameMs = 33,
): number {
  const [now, setNow] = useState(() => session.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    let frame = 0;
    let last = -Infinity;
    const loop = (time: number) => {
      frame = window.requestAnimationFrame(loop);
      if (time - last < frameMs) {
        return;
      }
      last = time;
      setNow(session.now());
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [active, frameMs, session]);
  return active ? now : session.now();
}
