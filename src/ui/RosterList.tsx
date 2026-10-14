import { useTranslation } from 'react-i18next';
import type { PlayerView } from '../engine/selectors';
import { Chip } from './Chip';

interface RosterListProps {
  roster: readonly PlayerView[];
  canKick: boolean;
  onKick: (playerId: string) => void;
}

export function RosterList({ roster, canKick, onKick }: RosterListProps) {
  const { t } = useTranslation();
  const connected = roster.filter(
    (player) => player.connected && player.status !== 'left',
  ).length;

  return (
    <section data-testid="roster-section" className="felt-panel rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('lobby.rosterHeading')}
        </h2>
        <span className="text-xs text-cream-100/70">
          {t('lobby.rosterCount', { count: connected })}
        </span>
      </div>
      <ul data-testid="roster" className="mt-3 space-y-2">
        {roster.map((player) => (
          <li
            key={player.id}
            data-testid="roster-row"
            data-player-id={player.id}
            data-self={player.isSelf}
            data-host={player.isHost}
            data-status={player.status}
            data-connected={player.connected}
            data-sound={player.soundUnlocked}
            data-participant={player.isParticipant}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-gold-400/20 bg-ink-950/75 px-3 py-2"
          >
            <span
              data-testid="player-nickname"
              className="min-w-0 flex-1 truncate text-sm text-cream-100"
            >
              {player.nickname}
            </span>
            {player.isSelf && (
              <span
                data-testid="player-self-badge"
                className="rounded-full border border-gold-400/40 px-2 py-0.5 text-[0.65rem] text-gold-300 uppercase"
              >
                {t('lobby.you')}
              </span>
            )}
            {player.isHost && (
              <span
                data-testid="player-host-badge"
                className="inline-flex items-center gap-1 rounded-full border border-gold-400/60 bg-gold-500/20 py-0.5 pr-2 pl-1 text-[0.65rem] text-gold-200 uppercase"
              >
                <Chip tone="gold" size="sm" />
                {t('lobby.hostBadge')}
              </span>
            )}
            {player.status === 'spectator' && (
              <span
                data-testid="player-spectator-badge"
                className="rounded-full border border-sky-400/40 px-2 py-0.5 text-[0.65rem] text-sky-200 uppercase"
              >
                {t('lobby.spectatorBadge')}
              </span>
            )}
            {player.status === 'kicked' && (
              <span
                data-testid="player-kicked-badge"
                className="rounded-full border border-rose-400/40 px-2 py-0.5 text-[0.65rem] text-rose-200 uppercase"
              >
                {t('lobby.kickedBadge')}
              </span>
            )}
            {!player.connected && player.status !== 'kicked' && (
              <span
                data-testid="player-disconnected-badge"
                className="rounded-full border border-amber-400/40 px-2 py-0.5 text-[0.65rem] text-amber-200 uppercase"
              >
                {t('lobby.disconnectedBadge')}
              </span>
            )}
            <span
              data-testid="player-sound-status"
              data-unlocked={player.soundUnlocked}
              className={
                player.soundUnlocked
                  ? 'rounded-full border border-emerald-400/40 px-2 py-0.5 text-[0.65rem] text-emerald-200'
                  : 'rounded-full border border-gold-400/30 px-2 py-0.5 text-[0.65rem] text-cream-100/75'
              }
            >
              {player.soundUnlocked ? t('lobby.soundOn') : t('lobby.soundOff')}
            </span>
            {canKick && !player.isSelf && player.status !== 'left' && (
              <button
                type="button"
                data-testid="kick-player"
                data-player-id={player.id}
                onClick={() => onKick(player.id)}
                className="rounded-md border border-rose-400/40 px-2 py-1 text-xs text-rose-200 transition hover:bg-rose-500/15"
              >
                {t('lobby.kick')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
