import { useTranslation } from 'react-i18next';
import { selectReveal, selectSongs } from '../engine/selectors';
import type { GameState } from '../shared/game';
import { LinkedAnimation } from './LinkedAnimation';

interface SingleSongPhaseProps {
  state: GameState;
  viewerId: string;
}

/**
 * FR-54 degenerate round: every player submitted the same video, so the round
 * goes straight to REVEAL without voting. M3 surfaces the linked presentation
 * here; scoring and the full reveal are M5.
 */
export function SingleSongPhase({ state, viewerId }: SingleSongPhaseProps) {
  const { t } = useTranslation();
  const reveal = selectReveal(state);
  if (!reveal || reveal.reason !== 'singleSong') {
    return null;
  }
  const songs = selectSongs(state, viewerId);
  const song = songs[0];
  return (
    <section data-testid="single-song" className="space-y-3">
      <p
        data-testid="single-song-notice"
        className="rounded-xl border border-gold-400/20 bg-felt-800/50 px-3 py-3 text-sm text-cream-100/70"
      >
        {t('linked.single')}
      </p>
      {song && (
        <p
          data-testid="single-song-title"
          className="text-sm text-cream-100/80"
        >
          {song.title}
        </p>
      )}
      <LinkedAnimation songs={songs} showEmptyMarker={false} />
    </section>
  );
}
