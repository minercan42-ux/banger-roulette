import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SongView } from '../engine/selectors';
import { useEmbedConsent } from './embed-consent';

interface LinkedAnimationProps {
  songs: SongView[];
  /** Playback preroll shows a marker even when nothing is linked (FR-26). */
  showEmptyMarker: boolean;
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

/**
 * FR-26 "Spiritually Linked" (docs/design/pixel-filz/components/SpiritLinked):
 * songs several players submitted under one video id or as different uploads
 * of the same song (#106) collapse into one
 * entry with multiple owners. Two flipped cards fly together, a golden chain
 * links them and the banner stamps on. The timeline is pure CSS that joins at
 * the server-derived `elapsedMs` (no client-side randomness, no mount-time
 * dependence). While anonymity is on, `SongView.owners` is empty, so no name
 * can leak before the reveal (AK-3).
 *
 * Reduced motion (CSS): the cards rest side by side, the chain is gone and the
 * banner and names fade in.
 */
export function LinkedAnimation({
  songs,
  showEmptyMarker,
  elapsedMs = 0,
  paused = false,
}: LinkedAnimationProps) {
  const { t } = useTranslation();
  const { consented } = useEmbedConsent();
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
  }, [hasLinked, paused]);

  if (!hasLinked) {
    return showEmptyMarker ? (
      <p data-testid="linked-animation-none" className="br-read">
        {t('linked.none')}
      </p>
    ) : null;
  }
  return (
    <section
      ref={rootRef}
      data-testid="linked-animation"
      data-linked-count={linked.length}
      aria-live="polite"
      aria-label={t('linked.heading')}
      className="br-linkedset"
    >
      {linked.map((song) => (
        <div
          key={song.videoId}
          data-testid="linked-song"
          data-video-id={song.videoId}
          data-owner-count={song.ownerCount}
          className="br-linkedset__item"
        >
          <div
            className={`br-linked${isNamed(song) ? ' br-linked--named' : ''}`}
          >
            {isNamed(song) && (
              <div
                data-testid="linked-names"
                className="br-linked__names br-label"
              >
                {t('linked.names', {
                  names: song.owners.map((owner) => owner.nickname).join(', '),
                })}
              </div>
            )}
            <LinkedCard
              song={song}
              consented={consented}
              className="br-linked__card--a"
            />
            <div className="br-linked__chain" />
            <LinkedCard
              song={song}
              consented={consented}
              className="br-linked__card--b"
            />
            <div className="br-linked__banner">{t('linked.banner')}</div>
          </div>
          <p className="br-linkedset__body">
            {t('linked.body', { count: song.ownerCount })}
          </p>
          {!isNamed(song) && (
            <p data-testid="linked-anonymous" className="br-linkedset__note">
              {t('linked.anonymousNote')}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

interface LinkedCardProps {
  song: SongView;
  consented: boolean;
  className: string;
}

/** One of the two flipped, identical cards. */
function LinkedCard({ song, consented, className }: LinkedCardProps) {
  return (
    <div className={`br-card is-flipped br-linked__card ${className}`}>
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
  );
}
