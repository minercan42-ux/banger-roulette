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
   * during the reveal): the animation joins at that offset so every client is
   * in the same frame. Read once at mount; 0 plays from the start.
   */
  elapsedMs?: number;
}

/** Owner names are only shown once the reveal made them public (AK-3). */
const isNamed = (song: SongView) =>
  song.ownersVisible && song.owners.length > 0;

/**
 * FR-26 "Spiritually Linked" (docs/design/pixel-filz/components/SpiritLinked):
 * songs several players submitted under the same video id collapse into one
 * entry with multiple owners. Two flipped cards fly together, a golden chain
 * links them and the banner stamps on. The timeline is pure CSS keyed to mount
 * time (no client-side randomness). While anonymity is on, `SongView.owners` is
 * empty, so no name can leak before the reveal (AK-3).
 *
 * Reduced motion (CSS): the cards rest side by side, the chain is gone and the
 * banner and names fade in.
 */
export function LinkedAnimation({
  songs,
  showEmptyMarker,
  elapsedMs = 0,
}: LinkedAnimationProps) {
  const { t } = useTranslation();
  const { consented } = useEmbedConsent();
  const rootRef = useRef<HTMLElement>(null);
  const joinedAt = useRef(elapsedMs);
  const linked = songs.filter((song) => song.linked);
  const hasLinked = linked.length > 0;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      joinedAt.current <= 0 ||
      typeof root.getAnimations !== 'function'
    ) {
      return;
    }
    for (const animation of root.getAnimations({ subtree: true })) {
      animation.currentTime = joinedAt.current;
    }
  }, [hasLinked]);

  if (!hasLinked) {
    return showEmptyMarker ? (
      <p
        data-testid="linked-animation-none"
        className="text-xs text-cream-100/50"
      >
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
