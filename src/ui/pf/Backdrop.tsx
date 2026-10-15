import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '../motion';

interface BackdropProps {
  /** Stronger swirl (`.is-hype`): spin and jackpot moments. */
  hype?: boolean;
  /** Swirl tempo, 1 = base speed. Ignored under reduced motion. */
  speed?: number;
}

/**
 * Pixel-Filz backdrop (docs/design/pixel-filz/components/Backdrop): swirling
 * felt plus CRT scanlines and vignette, rendered once by the Shell behind all
 * content. Decorative only. The swirl is a real child element so its running
 * animation can change tempo without a jump: the playback rate moves, never
 * `animation-duration`.
 *
 * Reduced motion: the swirl stands still (`br-*` reduced-motion block), the
 * colours stay, and no tempo change is applied.
 */
export function Backdrop({ hype = false, speed = 1 }: BackdropProps) {
  const reducedMotion = usePrefersReducedMotion();
  const swirlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const animation = swirlRef.current?.getAnimations()[0];
    animation?.updatePlaybackRate(reducedMotion ? 1 : speed);
  }, [reducedMotion, speed]);

  return (
    <div
      aria-hidden="true"
      data-testid="backdrop"
      className={`br-backdrop shell-backdrop${hype ? ' is-hype' : ''}`}
    >
      <div ref={swirlRef} className="br-backdrop__swirl" />
    </div>
  );
}
