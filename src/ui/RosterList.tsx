import { useTranslation } from 'react-i18next';
import type { PlayerView, RoomView } from '../engine/selectors';
import { Badge } from './pf/Badge';
import { Button } from './pf/Button';
import { Chip } from './pf/Chip';
import { Panel, PanelTitle } from './pf/Panel';

interface RosterListProps {
  roster: readonly PlayerView[];
  phase: RoomView['phase'];
  canKick: boolean;
  onKick: (playerId: string) => void;
}

export function RosterList({
  roster,
  phase,
  canKick,
  onKick,
}: RosterListProps) {
  const { t } = useTranslation();
  const connected = roster.filter(
    (player) => player.connected && player.status !== 'left',
  ).length;

  return (
    <Panel as="section" data-testid="roster-section">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <PanelTitle>{t('lobby.rosterHeading')}</PanelTitle>
        <span className="br-label">
          {t('lobby.rosterCount', { count: connected })}
        </span>
      </div>
      <ul
        data-testid="roster"
        tabIndex={0}
        aria-label={t('lobby.rosterHeading')}
        className="br-roster"
      >
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
            className="br-roster__row"
          >
            <span data-testid="player-nickname" className="br-roster__name">
              {player.nickname}
            </span>
            {phase !== 'LOBBY' && (
              <span data-testid="player-score" className="br-roster__score">
                {t('lobby.score', { count: player.totalScore })}
              </span>
            )}
            <span className="br-roster__badges">
              {player.isSelf && (
                <Badge data-testid="player-self-badge">{t('lobby.you')}</Badge>
              )}
              {player.isHost && (
                <Badge data-testid="player-host-badge" tone="gold" isNew>
                  <Chip tone="gold" size="sm" />
                  {t('lobby.hostBadge')}
                </Badge>
              )}
              {player.status === 'spectator' && (
                <Badge data-testid="player-spectator-badge" tone="ghost" isNew>
                  {t('lobby.spectatorBadge')}
                </Badge>
              )}
              {player.status === 'kicked' && (
                <Badge data-testid="player-kicked-badge" tone="red" isNew>
                  {t('lobby.kickedBadge')}
                </Badge>
              )}
              {!player.connected && player.status !== 'kicked' && (
                <Badge
                  data-testid="player-disconnected-badge"
                  tone="ghost"
                  isNew
                >
                  {t('lobby.disconnectedBadge')}
                </Badge>
              )}
              {phase === 'SUBMISSION' && player.submissionDone && (
                <Badge data-testid="player-done-badge" tone="green" dot>
                  {t('lobby.doneBadge')}
                </Badge>
              )}
              <Badge
                data-testid="player-sound-status"
                data-unlocked={player.soundUnlocked}
                tone={player.soundUnlocked ? 'green' : 'slate'}
                dot={player.soundUnlocked}
              >
                {player.soundUnlocked
                  ? t('lobby.soundOn')
                  : t('lobby.soundOff')}
              </Badge>
              {canKick && !player.isSelf && player.status !== 'left' && (
                <Button
                  tone="red"
                  size="sm"
                  data-testid="kick-player"
                  data-player-id={player.id}
                  onClick={() => onKick(player.id)}
                >
                  {t('lobby.kick')}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
