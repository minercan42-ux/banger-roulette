import { useTranslation } from 'react-i18next';
import {
  selectCurrentSong,
  selectPhaseTimer,
  selectRound,
  selectSongs,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { LinkedAnimation } from './LinkedAnimation';
import { PhaseUnavailable } from './PhaseUnavailable';
import { useSessionNow } from './use-session-now';

interface PlaybackPhaseProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
}

/**
 * The engine's three second PLAYBACK preroll is the FR-26 linked presentation
 * window. Actual synchronised playback is M4, so after the preroll the view
 * says so instead of faking a player.
 */
export function PlaybackPhase({
  session,
  state,
  viewerId,
}: PlaybackPhaseProps) {
  const { t } = useTranslation();
  const round = selectRound(state, viewerId);
  const song = selectCurrentSong(state, viewerId);
  const now = useSessionNow(session, true, 100);
  const timer = selectPhaseTimer(state, now);
  if (timer.phase !== 'PLAYBACK' || song === null) {
    return null;
  }
  const songs = selectSongs(state, viewerId);
  const clipMs = Math.max(1, Math.round(song.clipSeconds * 1000));
  const preroll =
    round?.playbackIndex === 0 && (timer.remainingMs ?? 0) > clipMs;

  return (
    <section data-testid="playback-phase" data-preroll={preroll}>
      {preroll ? (
        <>
          <p
            data-testid="playback-preroll"
            className="mb-3 text-sm text-cream-100/70"
          >
            {t('later.playbackPreroll')}
          </p>
          <LinkedAnimation songs={songs} showEmptyMarker />
        </>
      ) : (
        <PhaseUnavailable phase="PLAYBACK" />
      )}
    </section>
  );
}
