import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectFinal,
  selectResults,
  selectStandings,
  selectViewerPermissions,
  type StandingView,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { genreName } from './format';

interface FinalPhaseProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
  viewerConnectionId: string | null;
}

/** FR-62 finale: podium, full standings, every round-winning banger, rematch. */
export function FinalPhase({
  session,
  state,
  viewerId,
  viewerConnectionId,
}: FinalPhaseProps) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const final = selectFinal(state);
  const standings = selectStandings(state, viewerId);
  const results = selectResults(state);
  const permissions = selectViewerPermissions(
    state,
    viewerId,
    viewerConnectionId,
  );

  const podium: { rank: number; players: StandingView[] }[] = [];
  for (const row of standings) {
    const place = podium.find((entry) => entry.rank === row.rank);
    if (place) {
      place.players.push(row);
    } else {
      podium.push({ rank: row.rank, players: [row] });
    }
  }
  const topPodium = podium.filter((entry) => entry.rank <= 3);

  async function rematch() {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const result = await session.dispatch({ type: 'REMATCH' });
    setBusy(false);
    if (result.status === 'rejected') {
      setErrorKey(`errors.${result.reason}`);
    }
  }

  return (
    <section
      data-testid="final-phase"
      data-reason={final?.reason ?? 'unknown'}
      className="space-y-4 rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('final.heading')}
        </h2>
      </div>

      {final?.reason === 'hostEnded' && (
        <p
          data-testid="final-host-ended"
          className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          {t('final.hostEnded')}
        </p>
      )}

      <div>
        <h3 className="font-display text-base text-gold-200">
          {t('final.podiumHeading')}
        </h3>
        <ol className="mt-2 flex flex-wrap items-end gap-3">
          {topPodium.map((place) => (
            <li
              key={place.rank}
              data-testid="final-podium-place"
              data-rank={place.rank}
              className="min-w-[8rem] flex-1 rounded-xl border border-gold-400/30 bg-felt-950/60 p-3 text-center"
            >
              <p className="font-display text-sm text-gold-200">
                {t('final.place', { rank: place.rank })}
              </p>
              <ul className="mt-1 space-y-1">
                {place.players.map((player) => (
                  <li
                    key={player.playerId}
                    className="truncate text-sm text-cream-100"
                  >
                    {player.nickname}
                    {player.isSelf && (
                      <span className="ml-1 text-xs text-gold-300">
                        {t('lobby.you')}
                      </span>
                    )}
                    <span className="ml-1 text-xs text-cream-100/60">
                      {t('leaderboard.score', { points: player.totalScore })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="font-display text-base text-gold-200">
          {t('final.standingsHeading')}
        </h3>
        <ul data-testid="final-standings" className="mt-2 space-y-1">
          {standings.map((row) => (
            <li
              key={row.playerId}
              data-testid="final-standing-row"
              data-player-id={row.playerId}
              data-rank={row.rank}
              data-self={row.isSelf}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gold-400/15 bg-felt-950/60 px-3 py-2 text-sm"
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
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="font-display text-base text-gold-200">
          {t('final.bangersHeading')}
        </h3>
        <ol className="mt-2 space-y-3">
          {results.map((result) => {
            const winners = result.entries.filter((entry) => entry.winner);
            return (
              <li
                key={result.roundNumber}
                data-testid="final-round"
                data-round={result.roundNumber}
                className="rounded-lg border border-gold-400/15 bg-felt-950/60 p-3"
              >
                <p className="text-xs text-cream-100/60">
                  {t('final.round', {
                    number: result.roundNumber,
                    genre: genreName(result.genre, i18n.resolvedLanguage),
                  })}
                </p>
                {winners.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {winners.map((entry) => (
                      <li
                        key={entry.videoId}
                        data-testid="final-round-winner"
                        data-video-id={entry.videoId}
                        className="text-sm text-cream-100"
                      >
                        <a
                          href={entry.watchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline decoration-gold-400/60 underline-offset-2 hover:text-gold-200"
                        >
                          {entry.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-cream-100/60">
                    {result.reason === 'noSongs'
                      ? t('final.roundNoSongs')
                      : result.reason === 'singleSong'
                        ? t('final.roundSingleSong')
                        : t('final.roundAllFailed')}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {errorKey && (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
        >
          {t(errorKey)}
        </p>
      )}

      {permissions.canRematch ? (
        <button
          type="button"
          data-testid="final-rematch"
          onClick={() => {
            void rematch();
          }}
          disabled={busy}
          className="rounded-md border border-gold-400/50 bg-gold-500/15 px-4 py-2 text-sm text-gold-100 transition hover:bg-gold-500/25 disabled:opacity-50"
        >
          {t('final.rematch')}
        </button>
      ) : (
        <p
          data-testid="final-waiting-host"
          className="rounded-lg border border-gold-400/20 bg-felt-950/60 px-3 py-2 text-sm text-cream-100/70"
        >
          {t('final.waitingHost')}
        </p>
      )}
    </section>
  );
}
