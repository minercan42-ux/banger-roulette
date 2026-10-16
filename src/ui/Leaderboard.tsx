import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectStandings } from '../engine/selectors';
import type { GameState } from '../shared/game';
import { formatTenths } from './format';
import { usePrefersReducedMotion } from './motion';

interface LeaderboardProps {
  state: GameState;
  viewerId: string;
}

/** Pixel-Filz `dur-reveal` with `ease-spring` (components/Leaderboard). */
const SWAP_TRANSITION = { duration: 0.6, ease: [0.3, 1.6, 0.5, 1] } as const;

/**
 * FR-61 interim standings with animated place swaps (SPEC §6 motion-safe).
 * Ties share a place (FR-53): the selector hands out equal ranks, shown as
 * the same position number.
 */
export function Leaderboard({ state, viewerId }: LeaderboardProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const standings = selectStandings(state, viewerId);
  // Rows mount in the pre-round order and move to the new order one frame
  // later, so `layout` animates every place swap (none under reduced motion,
  // where the list jumps straight to the new order).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const rows =
    settled || reducedMotion
      ? standings
      : [...standings].sort((a, b) => a.previousRank - b.previousRank);

  return (
    <section
      data-testid="leaderboard"
      aria-labelledby="leaderboard-heading"
      className="br-panel br-panel--well"
    >
      <h2 id="leaderboard-heading" className="br-panel__title">
        {t('leaderboard.heading')}
      </h2>
      <ol className="br-lb">
        {rows.map((row) => {
          const moved = row.previousRank - row.rank;
          return (
            <motion.li
              key={row.playerId}
              layout={!reducedMotion}
              transition={reducedMotion ? { duration: 0 } : SWAP_TRANSITION}
              // Climbers pass over the rows they overtake.
              style={{ zIndex: moved > 0 ? 2 : 1 }}
              data-testid="leaderboard-row"
              data-player-id={row.playerId}
              data-rank={row.rank}
              data-self={row.isSelf}
              className={`br-lb__row${row.isSelf ? ' is-me' : ''}`}
            >
              <span className="br-lb__pos">{row.rank}.</span>
              <span className="min-w-0 truncate">
                {row.nickname}
                {row.isSelf && (
                  <span className="br-label ml-2 text-gold">
                    {t('lobby.you')}
                  </span>
                )}
              </span>
              <span className="whitespace-nowrap">
                <span
                  className={`br-lb__pts inline-block${row.delta > 0 && !reducedMotion ? ' br-bump' : ''}`}
                >
                  <span aria-hidden="true">{formatTenths(row.totalScore)}</span>
                  <span className="sr-only">
                    {t('leaderboard.score', {
                      points: formatTenths(row.totalScore),
                    })}
                  </span>
                </span>
                <span
                  data-testid="leaderboard-delta"
                  data-delta={row.delta}
                  data-from-rank={row.previousRank}
                  data-moved={moved}
                  className={`br-lb__delta${
                    moved > 0 ? ' is-up' : moved < 0 ? ' is-down' : ''
                  }`}
                >
                  {moved !== 0 && (
                    <>
                      <span aria-hidden="true">{Math.abs(moved)}</span>
                      <span className="sr-only">
                        {t(
                          moved > 0
                            ? 'leaderboard.placesGained'
                            : 'leaderboard.placesLost',
                          { count: Math.abs(moved) },
                        )}
                      </span>
                    </>
                  )}
                </span>
              </span>
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}
