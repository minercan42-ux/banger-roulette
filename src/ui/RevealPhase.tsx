import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import {
  selectReveal,
  selectSongs,
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
import { Badge } from './pf/Badge';
import { cx } from './pf/cx';
import { Jackpot, JackpotBadge, type JackpotWinner } from './pf/Jackpot';
import { Panel, PanelTitle } from './pf/Panel';
import { SongCard } from './pf/SongCard';
import { comboKind, comboValues, ScoreCombo } from './pf/ScoreCombo';
import { useSessionNow } from './use-session-now';

interface RevealScoreProps {
  entry: RevealEntryView;
  animate: boolean;
}

/** Borda votes, jackpot bonus (or genre-fail penalty) and the round score. */
function RevealScore({ entry, animate }: RevealScoreProps) {
  const { t } = useTranslation();
  const kind = comboKind(entry);
  return (
    <ScoreCombo
      {...comboValues(entry)}
      votesLabel={t('score.votes')}
      adjustLabel={
        kind === 'penalty' ? (
          <Badge tone="red">{t('score.penalty')}</Badge>
        ) : (
          t(`score.${kind}`)
        )
      }
      totalLabel={t('score.total')}
      animate={animate}
      className="mt-2"
    />
  );
}

/**
 * An entry that became visible longer ago than this (reload, late join) shows
 * its settled score instead of counting up again.
 */
const COUNT_UP_WINDOW_MS = 1500;

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

  // Card numbers follow the playback order; the place counts the songs that
  // scored higher, so ties share it (FR-53).
  const order = selectSongs(state, viewerId);

  const winners: JackpotWinner[] = reveal.entries
    .filter((entry) => entry.winner)
    .map((entry) => ({
      videoId: entry.videoId,
      revealAt: entry.revealAt,
      roundPoints: entry.roundPoints,
      names: entry.owners.map((owner) => owner.nickname),
    }));

  return (
    <Panel
      as="section"
      data-testid="reveal-phase"
      data-reason={reveal.reason}
      className="br-reveal space-y-4"
    >
      <Jackpot
        key={reveal.roundNumber}
        winners={winners}
        now={reference}
        paused={reveal.pausedAt !== null}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle>{t('reveal.heading')}</PanelTitle>
        <span className="br-label">
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
        <p data-testid="reveal-no-songs" className="br-notice">
          {t('reveal.noSongs')}
        </p>
      ) : (
        <ol className="br-stack">
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
              className={cx(
                'br-panel br-panel--well br-reveal__entry',
                entry.winner && 'is-winner',
              )}
            >
              <div className="flex flex-wrap items-start gap-4">
                {/* The owner stamp is the one place a card may name a player
                    (AK-3): only this phase passes `owner`. The row beside it
                    carries the same names as text, so the card is decoration. */}
                <SongCard
                  winner={entry.winner}
                  number={
                    order.findIndex((song) => song.videoId === entry.videoId) +
                    1
                  }
                  rank={
                    1 +
                    reveal.entries.filter(
                      (other) => other.roundPoints > entry.roundPoints,
                    ).length
                  }
                  song={entry}
                  showThumbnail={consented}
                  owner={entry.owners
                    .map((owner) => owner.nickname)
                    .join(' + ')}
                  flag={
                    entry.genreFailed ? (
                      <Badge tone="red">{t('card.genreFail')}</Badge>
                    ) : undefined
                  }
                />
                <div className="br-stack br-reveal__body">
                  <p className="br-reveal__title">{entry.title}</p>
                  <p className="br-read">{entry.channel}</p>
                  <p
                    data-testid="reveal-entry-owners"
                    className="br-read text-gold"
                  >
                    {t('reveal.owners', {
                      names: entry.owners
                        .map((owner) => owner.nickname)
                        .join(', '),
                    })}
                  </p>
                  {/* The screen reader and tests get the settled text at once;
                      the combo below is the animated, decorative version. */}
                  <p data-testid="reveal-entry-points" className="sr-only">
                    {t('reveal.points', {
                      borda: entry.borda,
                      bonus: entry.bonus,
                      points: entry.roundPoints,
                    })}
                  </p>
                  <RevealScore
                    entry={entry}
                    animate={reference - entry.revealAt < COUNT_UP_WINDOW_MS}
                  />
                  {entry.genreFailed && (
                    <p
                      data-testid="reveal-entry-genre-fail"
                      className="br-read text-red-text"
                    >
                      {t('reveal.genreFailed', {
                        flags: entry.flaggerIds.length,
                      })}
                    </p>
                  )}
                </div>
                {entry.winner && <JackpotBadge />}
              </div>
              {entry.linked && (
                <div className="mt-3">
                  <LinkedAnimation
                    songs={[asSongView(entry)]}
                    showEmptyMarker={false}
                    elapsedMs={reference - entry.revealAt}
                    paused={reveal.pausedAt !== null}
                  />
                </div>
              )}
            </motion.li>
          ))}
        </ol>
      )}

      {leaderboardVisible && <Leaderboard state={state} viewerId={viewerId} />}
    </Panel>
  );
}
