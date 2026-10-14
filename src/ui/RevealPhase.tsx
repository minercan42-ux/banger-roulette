import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  selectReveal,
  type RevealEntryView,
  type SongView,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { useEmbedConsent } from './embed-consent';
import { genreName } from './format';
import { Leaderboard } from './Leaderboard';
import { LinkedAnimation } from './LinkedAnimation';
import { usePrefersReducedMotion } from './motion';
import { useSessionNow } from './use-session-now';

interface RevealPhaseProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
}

/** Adapt a reveal entry to the owner-carrying view LinkedAnimation expects. */
function asSongView(entry: RevealEntryView): SongView {
  return {
    videoId: entry.videoId,
    title: entry.title,
    channel: entry.channel,
    thumbnail: entry.thumbnail,
    durationSeconds: 0,
    startSeconds: entry.startSeconds,
    clipSeconds: entry.clipSeconds,
    ownerCount: entry.ownerCount,
    ownedByViewer: false,
    owners: entry.owners,
    ownersVisible: true,
    linked: entry.linked,
  };
}

/**
 * FR-60 reveal: entries appear worst-first against server time, one every
 * `perSongMs`. Owner names are public from here on (AK-3); a late joiner or a
 * reload simply sees every entry whose `revealAt` already passed.
 */
export function RevealPhase({ session, state, viewerId }: RevealPhaseProps) {
  const { t, i18n } = useTranslation();
  const { consented } = useEmbedConsent();
  const reducedMotion = usePrefersReducedMotion();
  const reveal = selectReveal(state);
  const now = useSessionNow(
    session,
    reveal !== null && reveal.pausedAt === null,
  );

  if (!reveal) {
    return null;
  }

  const reference = reveal.pausedAt ?? now;
  const visible = reveal.entries.filter((entry) => entry.revealAt <= reference);
  const latest = visible[visible.length - 1];
  const lastRevealAt =
    reveal.entries.length === 0
      ? reveal.startedAt
      : reveal.entries[reveal.entries.length - 1].revealAt;
  const leaderboardVisible = reference >= lastRevealAt;

  return (
    <section
      data-testid="reveal-phase"
      data-reason={reveal.reason}
      className="space-y-4 rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('reveal.heading')}
        </h2>
        <span className="text-sm text-cream-100/70">
          {t('reveal.round', {
            number: reveal.roundNumber,
            genre: genreName(reveal.genre, i18n.resolvedLanguage),
          })}
        </span>
      </div>

      <p
        data-testid="reveal-announcement"
        aria-live="polite"
        className="sr-only"
      >
        {latest === undefined
          ? ''
          : latest.winner
            ? t('reveal.announceWinner', {
                title: latest.title,
                points: latest.roundPoints,
              })
            : t('reveal.announceEntry', {
                title: latest.title,
                points: latest.roundPoints,
              })}
      </p>

      {reveal.entries.length === 0 ? (
        <p
          data-testid="reveal-no-songs"
          className="rounded-lg border border-gold-400/20 bg-felt-950/60 px-3 py-3 text-sm text-cream-100/70"
        >
          {t('reveal.noSongs')}
        </p>
      ) : (
        <ol className="space-y-3">
          {visible.map((entry) => (
            <motion.li
              key={entry.videoId}
              layout={!reducedMotion}
              initial={reducedMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.4 }}
              data-testid="reveal-entry"
              data-video-id={entry.videoId}
              data-winner={entry.winner}
              data-genre-failed={entry.genreFailed}
              className={
                entry.winner
                  ? 'rounded-xl border border-gold-400/60 bg-gold-500/10 p-3'
                  : entry.genreFailed
                    ? 'rounded-xl border border-rose-400/40 bg-rose-500/10 p-3'
                    : 'rounded-xl border border-gold-400/20 bg-felt-950/60 p-3'
              }
            >
              <div className="flex flex-wrap items-start gap-3">
                {consented && (
                  // Thumbnails are YouTube content and only load after consent.
                  <img
                    src={entry.thumbnail}
                    alt=""
                    loading="lazy"
                    width={96}
                    height={54}
                    className="h-14 w-24 flex-none rounded-md border border-gold-400/20 object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-cream-100">
                    {entry.title}
                  </p>
                  <p className="truncate text-xs text-cream-100/60">
                    {entry.channel}
                  </p>
                  <p
                    data-testid="reveal-entry-owners"
                    className="mt-1 text-xs text-gold-200"
                  >
                    {t('reveal.owners', {
                      names: entry.owners
                        .map((owner) => owner.nickname)
                        .join(', '),
                    })}
                  </p>
                  <p
                    data-testid="reveal-entry-points"
                    className="mt-1 text-sm text-cream-100/80"
                  >
                    {t('reveal.points', {
                      borda: entry.borda,
                      bonus: entry.bonus,
                      points: entry.roundPoints,
                    })}
                  </p>
                  {entry.genreFailed && (
                    <p
                      data-testid="reveal-entry-genre-fail"
                      className="mt-1 text-xs text-rose-200"
                    >
                      {t('reveal.genreFailed', {
                        flags: entry.flaggerIds.length,
                      })}
                    </p>
                  )}
                </div>
                {entry.winner && (
                  <motion.div
                    data-testid="reveal-jackpot"
                    initial={reducedMotion ? false : { scale: 0.6, opacity: 0 }}
                    animate={{
                      scale: reducedMotion ? 1 : [0.6, 1.12, 1],
                      opacity: 1,
                      rotate: reducedMotion ? 0 : [0, -6, 6, 0],
                    }}
                    transition={{ duration: reducedMotion ? 0 : 0.7 }}
                    className="flex-none rounded-full border border-gold-400/60 bg-gold-500/20 px-3 py-1 font-display text-xs text-gold-100 uppercase"
                  >
                    {t('reveal.jackpot')}
                  </motion.div>
                )}
              </div>
              {entry.linked && (
                <div className="mt-3">
                  <LinkedAnimation
                    songs={[asSongView(entry)]}
                    showEmptyMarker={false}
                  />
                </div>
              )}
            </motion.li>
          ))}
        </ol>
      )}

      {leaderboardVisible && <Leaderboard state={state} viewerId={viewerId} />}
    </section>
  );
}
