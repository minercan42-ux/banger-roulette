import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { SongView } from '../engine/selectors';
import { useEmbedConsent } from './embed-consent';
import { formatTenths } from './format';
import { usePrefersReducedMotion } from './motion';
import { cx } from './pf/cx';

/**
 * Where the linked moment is staged. `reveal` is the payoff (owners and points,
 * FR-60); `preroll` is the anonymous teaser in the playback preroll (AK-3).
 */
export type LinkedVariant = 'preroll' | 'reveal';

/**
 * Length of the longest effect of each variant, in ms of the CSS timeline in
 * `styles.css` (the `.br-linked` block). The reveal one has to fit the 2500 ms
 * slot of a reveal entry, the preroll one the 3000 ms preroll; both are
 * measured against the engine constants in `LinkedAnimation.test.ts` and
 * against the running animations in `e2e/m10-linked-moment.spec.ts`.
 */
export const LINKED_REVEAL_MS = 2200;
export const LINKED_PREROLL_MS = 2000;

interface LinkedAnimationProps {
  songs: SongView[];
  /**
   * `preroll` also shows a marker when nothing is linked (FR-26) and never
   * names a player or a point; `reveal` shows every owner with their points.
   */
  variant: LinkedVariant;
  /**
   * Points every owner of the entry earned, in tenths (reveal only). The
   * engine gives every owner of a group the same delta (`ownerDeltas`).
   */
  pointsTenths?: number;
  /**
   * Another show owns the viewport for this moment (the banger show): the
   * linked moment does not play, it only rests at its settled frame, so no
   * second show stacks on the first.
   */
  held?: boolean;
  /**
   * Server time since the moment started, for a view that mounts late (reload
   * during the reveal or the preroll): the animation joins at that offset so
   * every client is in the same frame. Read when the animation mounts and
   * again on every pause/resume; 0 plays from the start.
   */
  elapsedMs?: number;
  /**
   * The shared timeline is frozen (host pause): the animation holds at
   * `elapsedMs` and continues from there on resume.
   */
  paused?: boolean;
}

/** Owner names are only shown once the reveal made them public (AK-3). */
const isNamed = (song: SongView) =>
  song.ownersVisible && song.owners.length > 0;

/**
 * Server time elapsed in the playback preroll of the first song: the preroll
 * starts `prerollMs` before `startAt` and is frozen at the pause instant while
 * the host paused, so every client sits at the same frame.
 */
export function prerollElapsedMs(
  view: { startAt: number; prerollMs: number; pausedAt: number | null },
  now: number,
): number {
  const reference = view.pausedAt ?? now;
  return Math.min(
    view.prerollMs,
    Math.max(0, reference - (view.startAt - view.prerollMs)),
  );
}

/** "Alice and Bob", "Alice, Bob and Cara": every owner, in the UI language. */
export function listNames(names: string[], language: string | undefined) {
  return new Intl.ListFormat(language === 'en' ? 'en' : 'de', {
    style: 'long',
    type: 'conjunction',
  }).format(names);
}

/** "+8.0" for a gain, "-1.5" for a genre-fail penalty that outweighs it. */
export function signedPoints(tenths: number): string {
  return `${tenths >= 0 ? '+' : ''}${formatTenths(tenths)}`;
}

/** The moment does not scroll the page this soon after the player's own input. */
const USER_INPUT_QUIET_MS = 2000;
let lastUserInputAt = Number.NEGATIVE_INFINITY;
if (typeof window !== 'undefined') {
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
    window.addEventListener(
      type,
      () => {
        lastUserInputAt = performance.now();
      },
      { passive: true },
    );
  }
}

/** Whether the player scrolled or typed within the quiet window before `now`. */
export function recentlyInteracted(
  lastInputAt: number,
  now: number,
  quietMs = USER_INPUT_QUIET_MS,
): boolean {
  return now - lastInputAt < quietMs;
}

/**
 * Whether a control outside the moment has keyboard focus: moving the page
 * would carry it (and its focus ring) out of the viewport. Nothing focused
 * (the body), or focus inside the moment itself, is fine.
 */
function holdsInteractiveFocus(root: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active !== null &&
    active !== document.body &&
    active !== document.documentElement &&
    !root.contains(active)
  );
}

/** The shell's bars that stick to the viewport edges on a phone. */
const TOP_BAR = '.br-table__top';
const BOTTOM_BAR = '.br-table__actions';

function stickyHeight(selector: string): number {
  const bar = document.querySelector(selector);
  return bar !== null && getComputedStyle(bar).position === 'sticky'
    ? bar.getBoundingClientRect().height
    : 0;
}

/**
 * How far to scroll so a box that is centred in the viewport sits in the
 * middle of the part the sticky bars leave free.
 */
function stickyBarShift(box: DOMRect): number {
  const free = (stickyHeight(TOP_BAR) - stickyHeight(BOTTOM_BAR)) / 2;
  return free === 0 ? 0 : box.top + box.height / 2 - (innerHeight / 2 + free);
}

const SPARK_COUNT = 14;
/**
 * The pixel burst at the impact: fixed vectors, so every client draws the same
 * frame (no client-side randomness). Near and far sparks alternate.
 */
const SPARKS = Array.from({ length: SPARK_COUNT }, (_, index) => {
  const angle = (index / SPARK_COUNT) * Math.PI * 2 + 0.2;
  const reach = index % 2 === 0 ? 150 : 92;
  return {
    dx: Math.round(Math.cos(angle) * reach * 1.5),
    dy: Math.round(Math.sin(angle) * reach * 0.8),
  };
});

/**
 * FR-26 "Spiritually Linked": songs several players submitted under one video
 * id or as different uploads of the same song (#106) collapse into one entry
 * with multiple owners (the owners cannot rate it; every owner earns the
 * entry's points). One face-down card per owner flies in from the sides, they
 * collide, flip face up, a gold chain clamps them together and the banner
 * stamps on. In the reveal every owner then gets a name plate with the points
 * they earned and the line "+8.0 for Alice and Bob"; the preroll variant stops
 * after the banner and stays anonymous. The timeline is pure CSS that joins at
 * the server-derived `elapsedMs` (no client-side randomness, no mount-time
 * dependence). While anonymity is on, `SongView.owners` is empty, so no name
 * can leak before the reveal (AK-3).
 *
 * Calm variant (reduced motion, or another show holds the viewport): the cards
 * rest face up in a row, the chain, banner, plates and points only fade in.
 *
 * Where it is seen: the reveal list grows downward, so a running reveal moment
 * scrolls itself to the middle of the viewport at most once per mount, and only
 * for an idle viewer: nothing outside the moment has focus, no wheel, touch,
 * key or pointer input in the last two seconds, and no other show holds the
 * viewport (all checked once, synchronously, when the entry mounts, before its
 * first paint). The preroll teaser never scrolls the page: the caller mounts it
 * inside the video frame (the video is not playing yet), where it is centred on
 * the player and can never cover the rating or skip controls; it never
 * coexists with the reveal shows.
 */
export function LinkedAnimation({
  songs,
  variant,
  pointsTenths,
  held = false,
  elapsedMs = 0,
  paused = false,
}: LinkedAnimationProps) {
  const { t, i18n } = useTranslation();
  const { consented } = useEmbedConsent();
  const reducedMotion = usePrefersReducedMotion();
  const calm = reducedMotion || held;
  const rootRef = useRef<HTMLElement>(null);
  const latestElapsed = useRef(elapsedMs);
  const wasPaused = useRef(false);
  const linked = songs.filter((song) => song.linked);
  const hasLinked = linked.length > 0;

  useLayoutEffect(() => {
    latestElapsed.current = elapsedMs;
  });

  useLayoutEffect(() => {
    const resumed = wasPaused.current && !paused;
    wasPaused.current = paused;
    const root = rootRef.current;
    if (
      !root ||
      (!paused && !resumed && latestElapsed.current <= 0) ||
      typeof root.getAnimations !== 'function'
    ) {
      return;
    }
    for (const animation of root.getAnimations({ subtree: true })) {
      // An effect already past its end stays at its settled frame: seeking
      // and `play()` would rewind it to zero (MDN Animation.play()), so the
      // cards would fly in again after a resume.
      const endTime = animation.effect?.getComputedTiming().endTime;
      if (typeof endTime === 'number' && endTime <= latestElapsed.current) {
        animation.finish();
        continue;
      }
      animation.currentTime = latestElapsed.current;
      if (paused) {
        animation.pause();
      } else if (resumed) {
        animation.play();
      }
    }
  }, [hasLinked, paused, calm]);

  // Bring a running reveal moment into view (see above). Once per mount: the
  // first attempt consumes the ref whether or not it scrolls, so a pause and
  // resume (or a changed prop) never re-arms it. A late join after the moment
  // already ended finds it settled and leaves the page where it is. A layout
  // effect, not a frame callback: the scroll happens in the commit that mounts
  // the entry, before the first paint, so a slow frame clock (a loaded WebKit
  // runner) cannot land it after the 700 ms impact.
  const following = variant === 'reveal' && hasLinked && !held && !paused;
  const followed = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!following || followed.current || !root) {
      return;
    }
    followed.current = true;
    if (
      typeof root.scrollIntoView !== 'function' ||
      latestElapsed.current >= LINKED_REVEAL_MS
    ) {
      return;
    }
    // The page only moves for a viewer who is idle.
    if (
      recentlyInteracted(lastUserInputAt, performance.now()) ||
      holdsInteractiveFocus(root)
    ) {
      return;
    }
    // Instant on purpose: the impact lands 700 ms in, a smooth scroll could
    // still be on its way then.
    root.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
    // On a phone the sticky top bar and action bar cover the viewport's
    // edges: centre the moment between them, not in the full viewport.
    const shift = stickyBarShift(root.getBoundingClientRect());
    if (shift !== 0) {
      window.scrollBy({ top: shift, behavior: 'instant' });
    }
  }, [following]);

  if (!hasLinked) {
    return variant === 'preroll' ? (
      <p data-testid="linked-animation-none" className="br-read">
        {t('linked.none')}
      </p>
    ) : null;
  }
  const revealed = variant === 'reveal';
  return (
    <section
      ref={rootRef}
      data-testid="linked-animation"
      data-variant={variant}
      data-motion={calm ? 'calm' : 'full'}
      data-held={held}
      data-linked-count={linked.length}
      aria-live="polite"
      aria-label={t('linked.heading')}
      className={cx('br-linkedset', !revealed && 'br-linkedset--overlay')}
    >
      {linked.map((song) => {
        const named = isNamed(song);
        const names = named ? song.owners.map((owner) => owner.nickname) : [];
        const seats = named ? song.owners.length : song.ownerCount;
        const showPoints = revealed && named && pointsTenths !== undefined;
        return (
          <div
            key={song.videoId}
            data-testid="linked-song"
            data-video-id={song.videoId}
            data-owner-count={song.ownerCount}
            className="br-linkedset__item"
          >
            <div
              className={cx(
                'br-linked',
                `br-linked--${variant}`,
                calm && 'br-linked--calm',
              )}
              style={{ '--n': seats } as CSSProperties}
            >
              {!calm && (
                <>
                  <div className="br-linked__flash" aria-hidden="true" />
                  <div className="br-linked__ring" aria-hidden="true" />
                  <div
                    className="br-linked__ring br-linked__ring--late"
                    aria-hidden="true"
                  />
                  <div className="br-linked__sparks" aria-hidden="true">
                    {SPARKS.map((spark, index) => (
                      <span
                        key={index}
                        className={`br-linked__spark br-linked__spark--${index % 3}`}
                        style={
                          {
                            '--dx': `${spark.dx}px`,
                            '--dy': `${spark.dy}px`,
                          } as CSSProperties
                        }
                      />
                    ))}
                  </div>
                </>
              )}
              <div className="br-linked__banner">{t('linked.banner')}</div>
              <div className="br-linked__seats">
                {Array.from({ length: seats }, (_, index) => (
                  <div
                    key={index}
                    data-testid={named ? 'linked-owner' : undefined}
                    className="br-linked__seat"
                    style={
                      {
                        '--i': index,
                        '--o': index - (seats - 1) / 2,
                      } as CSSProperties
                    }
                  >
                    {index > 0 && (
                      <span className="br-linked__link" aria-hidden="true" />
                    )}
                    <LinkedCard
                      song={song}
                      consented={consented}
                      faceUp={revealed}
                      calm={calm}
                    />
                    {named && (
                      <div className="br-linked__plate">
                        <span
                          data-testid="linked-owner-name"
                          className="br-linked__name"
                        >
                          {names[index]}
                        </span>
                        {showPoints && (
                          <span
                            data-testid="linked-owner-points"
                            data-points-tenths={pointsTenths}
                            className="br-linked__points"
                          >
                            {signedPoints(pointsTenths)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {showPoints ? (
              <p
                data-testid="linked-points"
                className="br-linkedset__body br-linkedset__body--points"
              >
                {t('linked.points', {
                  points: signedPoints(pointsTenths),
                  names: listNames(names, i18n.resolvedLanguage),
                })}
              </p>
            ) : (
              <p className="br-linkedset__body">
                {t('linked.body', { count: song.ownerCount })}
              </p>
            )}
            {!named && (
              <p data-testid="linked-anonymous" className="br-linkedset__note">
                {t('linked.anonymousNote')}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

interface LinkedCardProps {
  song: SongView;
  consented: boolean;
  /** The card lands face up (reveal); the preroll teaser stays face down. */
  faceUp: boolean;
  /** No flip to play: a face-up card is already turned. */
  calm: boolean;
}

/** One of the identical cards, one per owner; decoration for the plate below. */
function LinkedCard({ song, consented, faceUp, calm }: LinkedCardProps) {
  return (
    <div className="br-linked__cardbox" aria-hidden="true">
      <div
        className={cx(
          'br-card br-linked__card',
          faceUp && calm && 'is-flipped',
        )}
      >
        <span className="br-card__inner">
          <span className="br-card__back" />
          <span className="br-card__face br-card__face--front">
            <span className="br-card__corner">{song.ownerCount}x</span>
            <span className="br-card__mid">
              {consented ? (
                // Thumbnails are YouTube content and only load after consent.
                <img
                  src={song.thumbnail}
                  alt=""
                  loading="lazy"
                  className="br-card__thumb"
                />
              ) : (
                <span className="br-card__thumb" />
              )}
              <span className="br-card__title">{song.title}</span>
              <span className="br-card__sub">{song.channel}</span>
            </span>
            <span className="br-card__corner br-card__corner--end">
              {song.ownerCount}x
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
