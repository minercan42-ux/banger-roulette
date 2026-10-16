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
import { formatTenths, genreName } from './format';

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
      className="space-y-4"
    >
      <h2 className="br-panel__title">{t('final.heading')}</h2>

      {final?.reason === 'hostEnded' && (
        <p
          data-testid="final-host-ended"
          className="br-panel br-panel--well br-read text-red-text"
        >
          {t('final.hostEnded')}
        </p>
      )}

      <div className="space-y-2">
        <h3 className="br-label">{t('final.podiumHeading')}</h3>
        <ol className="br-podium">
          {topPodium.map((place) => (
            <li
              key={place.rank}
              data-testid="final-podium-place"
              data-rank={place.rank}
              className="br-podium__place"
            >
              <p className="br-podium__rank">
                {t('final.place', { rank: place.rank })}
              </p>
              <ul className="br-podium__players">
                {place.players.map((player) => (
                  <li key={player.playerId}>
                    <span className="br-podium__name">
                      {player.nickname}
                      {player.isSelf && (
                        <span className="br-label ml-2 text-gold">
                          {t('lobby.you')}
                        </span>
                      )}
                    </span>
                    <span className="br-podium__pts">
                      {t('leaderboard.score', {
                        points: formatTenths(player.totalScore),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-2">
        <h3 className="br-label">{t('final.standingsHeading')}</h3>
        <ol
          data-testid="final-standings"
          className="br-lb br-panel br-panel--well"
        >
          {standings.map((row) => (
            <li
              key={row.playerId}
              data-testid="final-standing-row"
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
              <span className="br-lb__pts whitespace-nowrap">
                <span aria-hidden="true">{formatTenths(row.totalScore)}</span>
                <span className="sr-only">
                  {t('leaderboard.score', {
                    points: formatTenths(row.totalScore),
                  })}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-2">
        <h3 className="br-label">{t('final.bangersHeading')}</h3>
        <ol className="br-final__rounds">
          {results.map((result) => {
            const winners = result.entries.filter((entry) => entry.winner);
            return (
              <li
                key={result.roundNumber}
                data-testid="final-round"
                data-round={result.roundNumber}
                className="br-panel br-panel--well"
              >
                <p className="br-label">
                  {t('final.round', {
                    number: result.roundNumber,
                    genre: genreName(result.genre, i18n.resolvedLanguage),
                  })}
                </p>
                {winners.length > 0 ? (
                  <ul className="br-final__winners">
                    {winners.map((entry) => (
                      <li
                        key={entry.videoId}
                        data-testid="final-round-winner"
                        data-video-id={entry.videoId}
                      >
                        <a
                          href={entry.watchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="br-final__link"
                        >
                          {entry.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="br-read mt-1">
                    {result.reason === 'noSongs'
                      ? t('final.roundNoSongs')
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
          className="br-panel br-panel--well br-read text-red-text"
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
          className="br-btn"
        >
          {t('final.rematch')}
        </button>
      ) : (
        <p
          data-testid="final-waiting-host"
          className="br-panel br-panel--well br-read"
        >
          {t('final.waitingHost')}
        </p>
      )}
    </section>
  );
}
