import {
  useLayoutEffect,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePrefersReducedMotion } from '../motion';
import { formatTenths } from '../format';
import { Badge } from './Badge';

/**
 * Whole show, `dur-jackpot` (docs/design/pixel-filz/components/Jackpot). It is
 * shorter than the engine's REVEAL_PER_SONG_MS (2500), so it is over before the
 * next reveal slot or the hold phase begins.
 */
export const JACKPOT_MS = 2400;
/** Screen shake (`br-shake`) length; a reload after this does not shake. */
const SHAKE_MS = 420;
const CHIP_COUNT = 26;
const HYPE_RATE = 10;
const TONES = ['', 'br-chip--blue', 'br-chip--gold'] as const;

export interface JackpotChip {
  /** Horizontal start, percent of the viewport width. */
  left: number;
  /** Start offset in ms (0..500). */
  delay: number;
  /** Fall duration in ms (1000..1300), so the last chip lands by 1800 ms. */
  fall: number;
  /** Horizontal drift in px. */
  drift: number;
  /** Total rotation in degrees, either direction. */
  spin: number;
  tone: (typeof TONES)[number];
  large: boolean;
}

/** FNV-1a: stable 32-bit hash of a string. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: tiny seeded PRNG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chip-rain parameters from the winning song ids. The engine supplies none and
 * every client must show the same rain (no client-side randomness), so they
 * derive from a hash of the song ids instead.
 */
export function jackpotChips(seed: string): JackpotChip[] {
  const random = seededRandom(hashSeed(seed));
  return Array.from({ length: CHIP_COUNT }, (_, index) => ({
    left: Math.round(random() * 1000) / 10,
    delay: Math.round(random() * 500),
    fall: 1000 + Math.round(random() * 300),
    drift: Math.round(random() * 80) - 40,
    spin: (360 + Math.round(random() * 360)) * (random() < 0.5 ? -1 : 1),
    tone: TONES[index % TONES.length],
    large: index % 4 === 0,
  }));
}

export interface JackpotWinner {
  videoId: string;
  /** Absolute server time this winner entry is revealed at. */
  revealAt: number;
  roundPoints: number;
  names: string[];
}

interface JackpotProps {
  /** Every winner of the round (ties: all, FR-51); none renders nothing. */
  winners: JackpotWinner[];
  /** Server-synced now (`reveal.pausedAt` while paused). */
  now: number;
  /** Reveal is paused: the show freezes where it is. */
  paused: boolean;
}

/**
 * Round-winner show (FR-60): "JACKPOT!" word, chip rain, shaking panel and a
 * faster backdrop swirl, once per round, in the reveal only. It starts at the
 * server time the last winner entry is revealed at (all winners are on screen
 * then) and ends `JACKPOT_MS` later, so every client shows the same moment; a
 * reload inside that window joins the show at the matching offset.
 *
 * Reduced motion: no rain, shake or swirl tempo; the word and the winners line
 * fade in, the winning card keeps its gold rim.
 */
export function Jackpot({ winners, now, paused }: JackpotProps) {
  if (winners.length === 0) {
    return null;
  }
  const startAt = Math.max(...winners.map((winner) => winner.revealAt));
  const elapsed = now - startAt;
  if (elapsed < 0 || elapsed >= JACKPOT_MS) {
    return null;
  }
  return <JackpotShow winners={winners} elapsed={elapsed} paused={paused} />;
}

interface JackpotShowProps {
  winners: JackpotWinner[];
  elapsed: number;
  paused: boolean;
}

function JackpotShow({ winners, elapsed, paused }: JackpotShowProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const showRef = useRef<HTMLDivElement>(null);
  // Offset into the show at mount; later renders only advance `now`.
  const joinedAt = useRef(elapsed);

  const chips = jackpotChips(winners.map((winner) => winner.videoId).join('|'));
  const names = [...new Set(winners.flatMap((winner) => winner.names))];
  const points = Math.max(...winners.map((winner) => winner.roundPoints));

  // A late join starts the CSS animations where the other clients are now.
  useLayoutEffect(() => {
    const show = showRef.current;
    if (
      !show ||
      joinedAt.current <= 0 ||
      typeof show.getAnimations !== 'function'
    ) {
      return;
    }
    for (const animation of show.getAnimations({ subtree: true })) {
      animation.currentTime = joinedAt.current;
    }
  }, []);

  // Shake the panel and speed up the backdrop swirl (Shell renders the
  // Backdrop once, so it is addressed through the DOM).
  useEffect(() => {
    if (reducedMotion) {
      return;
    }
    const cleanups: Array<() => void> = [];
    const backdrop = document.querySelector<HTMLElement>(
      '[data-testid="backdrop"]',
    );
    if (backdrop) {
      const swirl = backdrop.querySelector<HTMLElement>('.br-backdrop__swirl');
      const animation = swirl?.getAnimations()[0];
      backdrop.classList.add('is-hype');
      animation?.updatePlaybackRate(HYPE_RATE);
      cleanups.push(() => {
        backdrop.classList.remove('is-hype');
        animation?.updatePlaybackRate(1);
      });
    }
    const panel =
      anchorRef.current?.closest<HTMLElement>('.br-panel') ??
      anchorRef.current?.parentElement;
    if (panel && joinedAt.current < SHAKE_MS) {
      panel.classList.add('br-shake');
      const timer = window.setTimeout(
        () => panel.classList.remove('br-shake'),
        SHAKE_MS - joinedAt.current,
      );
      cleanups.push(() => {
        window.clearTimeout(timer);
        panel.classList.remove('br-shake');
      });
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [reducedMotion]);

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(
        <div
          ref={showRef}
          data-testid="jackpot-show"
          aria-hidden="true"
          className={`br-jackpot${paused ? ' is-paused' : ''}`}
        >
          {!reducedMotion && (
            <div className="br-rain">
              {chips.map((chip, index) => (
                <span
                  key={index}
                  className={`br-chip ${chip.tone}${chip.large ? ' br-chip--lg' : ''}`}
                  style={
                    {
                      left: `${chip.left}%`,
                      '--delay': `${chip.delay}ms`,
                      '--fall': `${chip.fall}ms`,
                      '--drift': `${chip.drift}px`,
                      '--spin': `${chip.spin}deg`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          )}
          <div className="br-overlay">
            <div>
              <div className="br-jackpot__word">{t('reveal.jackpotWord')}</div>
              <div className="br-jackpot__sub">
                {t('reveal.jackpotSub', {
                  points: formatTenths(points),
                  names: names.join(', '),
                })}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Persistent winner mark on the winning entry once the show is over (and the
 * element the e2e suite and bots look for).
 */
export function JackpotBadge(): ReactElement {
  const { t } = useTranslation();
  return (
    <Badge data-testid="reveal-jackpot" tone="gold" dot>
      {t('reveal.jackpot')}
    </Badge>
  );
}
