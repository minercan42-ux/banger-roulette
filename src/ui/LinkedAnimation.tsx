import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import type { SongView } from '../engine/selectors';
import { usePrefersReducedMotion } from './motion';

interface LinkedAnimationProps {
  songs: SongView[];
  /** Playback preroll shows a marker even when nothing is linked (FR-26). */
  showEmptyMarker: boolean;
}

/**
 * FR-26 "Spiritually Linked": songs several players submitted under the same
 * video id collapse into one entry with multiple owners. While anonymity is on,
 * `SongView.owners` is empty, so no name can leak before the reveal (AK-3).
 */
export function LinkedAnimation({
  songs,
  showEmptyMarker,
}: LinkedAnimationProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const linked = songs.filter((song) => song.linked);
  if (linked.length === 0) {
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
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.45 }}
      data-testid="linked-animation"
      data-linked-count={linked.length}
      aria-live="polite"
      className="rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/10 p-4"
    >
      <h2 className="font-display text-lg text-fuchsia-200">
        {t('linked.heading')}
      </h2>
      <ul className="mt-2 space-y-2">
        {linked.map((song) => (
          <li
            key={song.videoId}
            data-testid="linked-song"
            data-video-id={song.videoId}
            data-owner-count={song.ownerCount}
            className="rounded-lg border border-fuchsia-400/25 bg-felt-900/50 px-3 py-2 text-sm text-cream-100"
          >
            <p className="font-semibold">
              {t('linked.body', { count: song.ownerCount })}
            </p>
            <p className="text-cream-100/80">{song.title}</p>
            {song.ownersVisible && song.owners.length > 0 ? (
              <p
                data-testid="linked-names"
                className="text-xs text-fuchsia-200"
              >
                {t('linked.names', {
                  names: song.owners.map((owner) => owner.nickname).join(', '),
                })}
              </p>
            ) : (
              <p
                data-testid="linked-anonymous"
                className="text-xs text-cream-100/60"
              >
                {t('linked.anonymousNote')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </motion.section>
  );
}
