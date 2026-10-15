import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectRoom } from '../engine/selectors';
import type {
  LobbyReadinessView,
  ViewerPermissions,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { ClientAction } from '../shared/actions';
import type { GameState } from '../shared/game';
import { Button } from './pf/Button';
import { Panel } from './pf/Panel';

interface HostControlsProps {
  session: GameSession;
  state: GameState;
  permissions: ViewerPermissions;
  readiness: LobbyReadinessView;
}

/**
 * Host-authoritative controls the M3 phases really need: starting a ready
 * lobby (FR-06/07) and pausing, resuming or ending a running game (FR-06). No
 * skip/advance control: the genre spin and phases advance on their own
 * deadlines, so the wheel can never be skipped accidentally.
 */
export function HostControls({
  session,
  state,
  permissions,
  readiness,
}: HostControlsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  const phase = selectRoom(state).phase;
  const timed = phase !== 'LOBBY' && phase !== 'FINAL';
  const lobby = phase === 'LOBBY';

  if (
    !lobby &&
    !permissions.canPause &&
    !permissions.canResume &&
    !permissions.canEndGame
  ) {
    return null;
  }
  if (lobby && !permissions.isHost) {
    return null;
  }

  async function dispatch(action: ClientAction) {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const result = await session.dispatch(action);
    setBusy(false);
    if (result.status === 'rejected') {
      setErrorKey(`errors.${result.reason}`);
    }
  }

  const startDisabled = !permissions.canStartGame || !readiness.ready || busy;

  return (
    <Panel
      as="section"
      data-testid="host-controls"
      data-phase={phase}
      className="space-y-2"
    >
      {errorKey && (
        <p
          data-testid="host-error"
          role="alert"
          className="br-read text-red-text"
        >
          {t(errorKey)}
        </p>
      )}

      {lobby && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            data-testid="start-game"
            disabled={startDisabled}
            onClick={() => {
              void dispatch({ type: 'START_GAME' });
            }}
          >
            {t('host.start')}
          </Button>
          {!readiness.ready && (
            <span data-testid="start-hint" className="br-read">
              {readiness.connectedPlayers < readiness.minPlayers
                ? t('host.notReadyCount', { min: readiness.minPlayers })
                : t('host.notReadySound')}
            </span>
          )}
        </div>
      )}

      {timed && (
        <div className="flex flex-wrap items-center gap-3">
          {permissions.canPause && (
            <Button
              tone="blue"
              data-testid="host-pause"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'PAUSE' });
              }}
            >
              {t('host.pause')}
            </Button>
          )}
          {permissions.canResume && (
            <Button
              data-testid="host-resume"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'RESUME', forceBelowMinimum: false });
              }}
            >
              {t('host.resume')}
            </Button>
          )}
          {permissions.canResume && force && (
            <Button
              tone="red"
              data-testid="host-resume-force"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'RESUME', forceBelowMinimum: true });
              }}
            >
              {t('host.resumeForce')}
            </Button>
          )}
          {permissions.canResume && !force && (
            <button
              type="button"
              data-testid="host-force-toggle"
              onClick={() => setForce(true)}
              className="br-replay"
            >
              {t('host.forceHint')}
            </button>
          )}
          {permissions.canEndGame && (
            <Button
              tone="red"
              data-testid="host-end"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'END_GAME' });
              }}
            >
              {t('host.end')}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}
