import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { selectStandings } from '../engine/selectors';
import type { GameState } from '../shared/game';
import { usePrefersReducedMotion } from './motion';

interface LeaderboardProps {
  state: GameState;
  viewerId: string;
}

/** FR-61 interim standings with animated position changes (SPEC §6 motion-safe). */
export function Leaderboard({ state, viewerId }: LeaderboardProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const standings = selectStandings(state, viewerId);

  return (
    <section
      data-testid="leaderboard"
      aria-labelledby="leaderboard-heading"
      className="rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <h2
        id="leaderboard-heading"
        className="font-display text-lg text-gold-300"
      >
        {t('leaderboard.heading')}
      </h2>
      <motion.ul layout={!reducedMotion} className="mt-3 space-y-2">
        {standings.map((row) => {
          const moved = row.previousRank - row.rank;
          return (
            <motion.li
              key={row.playerId}
              layout={!reducedMotion}
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reducedMotion ? 0 : 0.3 }}
              data-testid="leaderboard-row"
              data-player-id={row.playerId}
              data-rank={row.rank}
              data-self={row.isSelf}
              className={
                row.isSelf
                  ? 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gold-400/50 bg-gold-500/10 px-3 py-2 text-sm'
                  : 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gold-400/15 bg-felt-950/60 px-3 py-2 text-sm'
              }
            >
              <span className="w-6 text-center font-display text-gold-200">
                {row.rank}
              </span>
              <span className="min-w-0 flex-1 truncate text-cream-100">
                {row.nickname}
                {row.isSelf && (
                  <span className="ml-2 text-xs text-gold-300">
                    {t('lobby.you')}
                  </span>
                )}
              </span>
              <span className="text-cream-100/80">
                {t('leaderboard.score', { points: row.totalScore })}
              </span>
              <span
                data-testid="leaderboard-delta"
                data-delta={row.delta}
                data-from-rank={row.previousRank}
                data-moved={moved}
                className={
                  moved > 0
                    ? 'w-16 text-right text-emerald-300'
                    : moved < 0
                      ? 'w-16 text-right text-rose-300'
                      : 'w-16 text-right text-cream-100/60'
                }
              >
                {row.delta > 0
                  ? t('leaderboard.deltaUp', { points: row.delta })
                  : row.delta < 0
                    ? t('leaderboard.deltaDown', { points: row.delta })
                    : t('leaderboard.deltaNone')}
              </span>
            </motion.li>
          );
        })}
      </motion.ul>
    </section>
  );
}
