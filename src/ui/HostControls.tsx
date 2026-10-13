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
    <section
      data-testid="host-controls"
      data-phase={phase}
      className="rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      {errorKey && (
        <p
          data-testid="host-error"
          role="alert"
          className="mb-2 text-xs text-rose-300"
        >
          {t(errorKey)}
        </p>
      )}

      {lobby && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="start-game"
            disabled={startDisabled}
            onClick={() => {
              void dispatch({ type: 'START_GAME' });
            }}
            className="rounded-md border border-emerald-400/50 bg-emerald-500/20 px-4 py-2 text-sm text-cream-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('host.start')}
          </button>
          {!readiness.ready && (
            <span data-testid="start-hint" className="text-xs text-amber-200">
              {readiness.connectedPlayers < readiness.minPlayers
                ? t('host.notReadyCount', { min: readiness.minPlayers })
                : t('host.notReadySound')}
            </span>
          )}
        </div>
      )}

      {timed && (
        <div className="flex flex-wrap items-center gap-2">
          {permissions.canPause && (
            <button
              type="button"
              data-testid="host-pause"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'PAUSE' });
              }}
              className="rounded-md border border-amber-400/50 px-3 py-2 text-sm text-amber-100 transition hover:bg-amber-500/15 disabled:opacity-50"
            >
              {t('host.pause')}
            </button>
          )}
          {permissions.canResume && (
            <button
              type="button"
              data-testid="host-resume"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'RESUME', forceBelowMinimum: false });
              }}
              className="rounded-md border border-emerald-400/50 px-3 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/15 disabled:opacity-50"
            >
              {t('host.resume')}
            </button>
          )}
          {permissions.canResume && force && (
            <button
              type="button"
              data-testid="host-resume-force"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'RESUME', forceBelowMinimum: true });
              }}
              className="rounded-md border border-rose-400/50 px-3 py-2 text-sm text-rose-100 transition hover:bg-rose-500/15 disabled:opacity-50"
            >
              {t('host.resumeForce')}
            </button>
          )}
          {permissions.canResume && !force && (
            <button
              type="button"
              data-testid="host-force-toggle"
              onClick={() => setForce(true)}
              className="text-xs text-cream-100/60 underline"
            >
              {t('host.forceHint')}
            </button>
          )}
          {permissions.canEndGame && (
            <button
              type="button"
              data-testid="host-end"
              disabled={busy}
              onClick={() => {
                void dispatch({ type: 'END_GAME' });
              }}
              className="rounded-md border border-rose-400/40 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/15 disabled:opacity-50"
            >
              {t('host.end')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
