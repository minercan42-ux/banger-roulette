import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { formatTenths } from '../format';
import { usePrefersReducedMotion } from '../motion';
import { hashSeed, seededRandom } from './Jackpot';
import { SongCard } from './SongCard';

/**
 * Whole show. The engine gives a banger entry `BANGER_REVEAL_MS` (5000) on the
 * stage; the show is exactly that long, so it is over when the next reveal slot
 * or the hold phase begins (pinned in `BangerShow.test.tsx`). Every timing in
 * the `.br-banger` block of `styles.css` is a point on this 5000 ms timeline.
 */
export const BANGER_SHOW_MS = 5000;
/** The kick that lands the stamp; the strobe and the finale ride the same beat. */
export const BANGER_BEAT_MS = 500;
/** When the finale (confetti burst, last shake, final hit of the sound) lands. */
export const BANGER_FINALE_MS = 3800;
/** Steps of the generated screen shake (one position per step, pixel look). */
const SHAKE_STEP_MS = 50;
/** Shake windows on the timeline: the stamp impact and the finale. */
const SHAKE_WINDOWS = [
  { from: 300, lengthMs: 800, amplitude: 14 },
  { from: BANGER_FINALE_MS, lengthMs: 1000, amplitude: 18 },
] as const;
const CHIP_COUNT = 72;
const CONFETTI_COUNT = 64;
const HYPE_RATE = 10;
const CHIP_TONES = ['', 'br-chip--blue', 'br-chip--gold'] as const;
const CONFETTI_TONES = 5;

export interface BangerChip {
  /** Horizontal start, percent of the viewport width. */
  left: number;
  /** Start offset in ms. */
  delay: number;
  /** Fall duration in ms; `delay + fall` stays inside the show. */
  fall: number;
  /** Horizontal drift in px. */
  drift: number;
  /** Total rotation in degrees, either direction. */
  spin: number;
  tone: (typeof CHIP_TONES)[number];
  large: boolean;
}

export interface BangerConfetti {
  /** Burst target relative to the centre, in vmin. */
  dx: number;
  dy: number;
  /** Total rotation in degrees. */
  spin: number;
  /** Start offset after the finale hit, in ms. */
  delay: number;
  /** Colour class index. */
  tone: number;
  /** Tall paper strip instead of a square. */
  strip: boolean;
}

export interface BangerParams {
  chips: BangerChip[];
  confetti: BangerConfetti[];
  /** Offset (px) of the shake in each `SHAKE_STEP_MS` step of the show. */
  shake: Array<{ x: number; y: number }>;
}

/**
 * Every parameter of the show, derived from the song id: the engine supplies
 * none and every client has to see the same moment (no client randomness).
 */
export function bangerParams(seed: string): BangerParams {
  const random = seededRandom(hashSeed(`banger|${seed}`));
  const chips = Array.from({ length: CHIP_COUNT }, (_, index) => {
    const delay = 250 + Math.round(random() * 2300);
    return {
      left: Math.round(random() * 1000) / 10,
      delay,
      fall: 1300 + Math.round(random() * 600),
      drift: Math.round(random() * 120) - 60,
      spin: (360 + Math.round(random() * 540)) * (random() < 0.5 ? -1 : 1),
      tone: CHIP_TONES[index % CHIP_TONES.length],
      large: index % 3 === 0,
    };
  });
  const confetti = Array.from({ length: CONFETTI_COUNT }, (_, index) => {
    const angle =
      (index / CONFETTI_COUNT) * Math.PI * 2 + (random() - 0.5) * 0.35;
    const reach = 22 + random() * 34;
    return {
      dx: Math.round(Math.cos(angle) * reach * 10) / 10,
      dy: Math.round((Math.sin(angle) * reach - 8) * 10) / 10,
      spin: (360 + Math.round(random() * 720)) * (random() < 0.5 ? -1 : 1),
      delay: Math.round(random() * 140),
      tone: index % CONFETTI_TONES,
      strip: random() < 0.5,
    };
  });
  const shake = Array.from(
    { length: BANGER_SHOW_MS / SHAKE_STEP_MS + 1 },
    (_, step) => {
      const at = step * SHAKE_STEP_MS;
      const window = SHAKE_WINDOWS.find(
        (candidate) =>
          at >= candidate.from && at < candidate.from + candidate.lengthMs,
      );
      if (window === undefined) {
        return { x: 0, y: 0 };
      }
      // The jolt dies out over its window; the sign comes from the seed.
      const decay = 1 - (at - window.from) / window.lengthMs;
      const amplitude = window.amplitude * decay;
      return {
        x: Math.round((random() * 2 - 1) * amplitude),
        y: Math.round((random() * 2 - 1) * amplitude),
      };
    },
  );
  return { chips, confetti, shake };
}

/** Web Animations keyframes of the screen shake (one step per position). */
export function shakeKeyframes(shake: BangerParams['shake']): Keyframe[] {
  return shake.map((position, step) => ({
    offset: step / (shake.length - 1),
    transform: `translate(${position.x}px, ${position.y}px)`,
    easing: 'steps(1, end)',
  }));
}

/** One banger entry of the reveal, as the show needs it. */
export interface BangerEntry {
  videoId: string;
  /** Absolute server time the entry is revealed at. */
  revealAt: number;
  /** Stage time of the entry (`RevealEntryView.slotMs`). */
  slotMs: number;
  /** Song number printed on the card (playback order). */
  number: number;
  title: string;
  channel: string;
  thumbnail: string;
  scoreTenths: number;
  roundPoints: number;
  /** Jackpot or linked bonus in tenths; the show names it when it is not 0. */
  bonus: number;
  names: string[];
}

interface BangerShowProps {
  /** Every banger entry of the round; none renders nothing. */
  entries: BangerEntry[];
  /** Server-synced now (`reveal.pausedAt` while paused). */
  now: number;
  /** Reveal is paused: the show freezes where it is. */
  paused: boolean;
  /** The thumbnail is YouTube content and only loads after the consent. */
  showThumbnail: boolean;
}

/**
 * "THIS IS A BANGER" (FR-60): the owner's favourite moment, for a song whose
 * ratings are all 10. It owns the viewport for the entry's whole reveal slot,
 * starts at the entry's `revealAt` on every client (server time, so every
 * screen shows the same frame) and replaces the jackpot show for that entry.
 * A reload inside the slot joins the show at the matching offset; a pause
 * freezes it.
 *
 * Full motion: stamp-in slogan, a screen shake on the impact and the finale,
 * a strobing gold/red light sweep (two flashes a second at most, WCAG 2.3.1),
 * dense chip rain, the swirl at hype tempo, the song card flying to the centre
 * with the owner stamps and "10.0", a confetti burst at the end.
 *
 * Reduced motion: no shake, strobe, rain or confetti; the slogan, the card and
 * a static gold burst fade in.
 */
export function BangerShow({
  entries,
  now,
  paused,
  showThumbnail,
}: BangerShowProps) {
  const active = entries.find(
    (entry) => now >= entry.revealAt && now < entry.revealAt + entry.slotMs,
  );
  if (active === undefined) {
    return null;
  }
  return (
    <BangerStage
      // A second banger in the same round is a new show, not a continuation.
      key={active.videoId}
      entry={active}
      elapsed={now - active.revealAt}
      paused={paused}
      showThumbnail={showThumbnail}
    />
  );
}

interface BangerStageProps {
  entry: BangerEntry;
  elapsed: number;
  paused: boolean;
  showThumbnail: boolean;
}

/**
 * Put every animation at `elapsed` ms on the shared timeline. An effect that
 * is already past its end stays at its settled frame: seeking it and `play()`
 * would rewind it to zero (MDN Animation.play()), like in `LinkedAnimation`.
 */
function seekAnimations(
  animations: Animation[],
  elapsed: number,
  paused: boolean,
  resumed: boolean,
): void {
  for (const animation of animations) {
    const endTime = animation.effect?.getComputedTiming().endTime;
    if (typeof endTime === 'number' && endTime <= elapsed) {
      animation.finish();
      continue;
    }
    animation.currentTime = elapsed;
    if (paused) {
      animation.pause();
    } else if (resumed) {
      animation.play();
    }
  }
}

function BangerStage({
  entry,
  elapsed,
  paused,
  showThumbnail,
}: BangerStageProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const showRef = useRef<HTMLDivElement>(null);
  const latestElapsed = useRef(elapsed);
  const wasPaused = useRef(false);
  // Animations the show runs outside its own subtree (the shaken panel).
  const outside = useRef<Animation[]>([]);

  const params = bangerParams(entry.videoId);
  const names = entry.names;

  useLayoutEffect(() => {
    latestElapsed.current = elapsed;
  });

  // The swirl runs at hype tempo and the panel shakes. Both are addressed
  // through the DOM: the Shell renders the backdrop once and owns the panel.
  useLayoutEffect(() => {
    if (reducedMotion || typeof document.body.getAnimations !== 'function') {
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
    if (panel) {
      const shake = panel.animate(shakeKeyframes(params.shake), {
        duration: BANGER_SHOW_MS,
        fill: 'none',
      });
      outside.current = [shake];
      cleanups.push(() => {
        shake.cancel();
        outside.current = [];
      });
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    // `params` derives from the video id, which is this component's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  // Join at the server-derived offset (late mount, reload), freeze on pause,
  // continue from the frozen frame on resume.
  useLayoutEffect(() => {
    const resumed = wasPaused.current && !paused;
    wasPaused.current = paused;
    const show = showRef.current;
    if (!show || typeof show.getAnimations !== 'function') {
      return;
    }
    seekAnimations(
      [...show.getAnimations({ subtree: true }), ...outside.current],
      latestElapsed.current,
      paused,
      resumed,
    );
  }, [paused, reducedMotion]);

  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(
        <div
          ref={showRef}
          data-testid="banger-show"
          data-video-id={entry.videoId}
          aria-hidden="true"
          className="br-banger"
        >
          <div className="br-banger__scrim" />
          {reducedMotion && (
            <div data-testid="banger-burst" className="br-banger__burst" />
          )}
          <div className="br-banger__world">
            {!reducedMotion && (
              <>
                <div className="br-banger__rays" />
                <div className="br-banger__beam br-banger__beam--left" />
                <div className="br-banger__beam br-banger__beam--right" />
                <div
                  data-testid="banger-strobe"
                  className="br-banger__strobe"
                />
                <div className="br-banger__ring" />
                <div className="br-banger__ring br-banger__ring--finale" />
                <div data-testid="banger-rain" className="br-banger__rain">
                  {params.chips.map((chip, index) => (
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
              </>
            )}
            <div className="br-banger__content">
              <div data-testid="banger-word" className="br-banger__word">
                {t('banger.word')}
              </div>
              <div className="br-banger__row">
                <div className="br-banger__cardwrap">
                  <div data-testid="banger-card" className="br-banger__card">
                    <SongCard
                      winner
                      number={entry.number}
                      song={entry}
                      showThumbnail={showThumbnail}
                    />
                  </div>
                  <div className="br-banger__stamps">
                    {names.map((name, index) => (
                      <span
                        key={index}
                        data-testid="banger-owner"
                        className="br-banger__stamp"
                        style={{ '--i': index } as CSSProperties}
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="br-banger__result">
                  <div data-testid="banger-score" className="br-banger__score">
                    {formatTenths(entry.scoreTenths)}
                  </div>
                  <div data-testid="banger-sub" className="br-banger__sub">
                    {t('banger.sub', {
                      points: formatTenths(entry.roundPoints),
                      names: names.join(', '),
                    })}
                  </div>
                  {entry.bonus !== 0 && (
                    <div
                      data-testid="banger-bonus"
                      className="br-banger__sub br-banger__sub--bonus"
                    >
                      {t('banger.bonus', {
                        bonus: `${entry.bonus > 0 ? '+' : ''}${formatTenths(entry.bonus)}`,
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {!reducedMotion && (
              <div
                data-testid="banger-confetti"
                className="br-banger__confetti"
              >
                {params.confetti.map((piece, index) => (
                  <span
                    key={index}
                    className={`br-banger__piece br-banger__piece--${piece.tone}${piece.strip ? ' is-strip' : ''}`}
                    style={
                      {
                        '--dx': `${piece.dx}vmin`,
                        '--dy': `${piece.dy}vmin`,
                        '--spin': `${piece.spin}deg`,
                        '--delay': `${BANGER_FINALE_MS + piece.delay}ms`,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
