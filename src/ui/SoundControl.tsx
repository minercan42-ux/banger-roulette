import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameSession } from '../net/session';

interface SoundControlProps {
  session: GameSession;
  canWrite: boolean;
  unlocked: boolean;
}

/**
 * FR-07 local audio unlock. The consent click really resumes an AudioContext
 * and only then reports SOUND_STATUS. It proves the browser permits audio, not
 * YouTube autoplay (no player exists in M2). Any failure resets to `false`.
 */
export function SoundControl({
  session,
  canWrite,
  unlocked,
}: SoundControlProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const [locallyUnlocked, setLocallyUnlocked] = useState(false);
  const resetInFlight = useRef(false);
  const soundReady = locallyUnlocked && unlocked;

  // A retained actor's old flag is not proof of this tab's audio permission.
  useEffect(() => {
    if (!canWrite || !unlocked || locallyUnlocked || resetInFlight.current) {
      return;
    }
    resetInFlight.current = true;
    void session
      .dispatch({ type: 'SOUND_STATUS', unlocked: false })
      .finally(() => {
        resetInFlight.current = false;
      });
  }, [canWrite, unlocked, locallyUnlocked, session]);

  useEffect(
    () => () => {
      const context = contextRef.current;
      if (context !== null && context.state !== 'closed') {
        void context.close();
      }
    },
    [],
  );

  async function enable() {
    if (busy || !canWrite || soundReady) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      if (!window.AudioContext) {
        throw new Error('AudioContext unavailable');
      }
      const context = contextRef.current ?? new window.AudioContext();
      contextRef.current = context;
      await context.resume();
      if (context.state !== 'running') {
        throw new Error('AudioContext did not resume');
      }
      setLocallyUnlocked(true);
      const result = await session.dispatch({
        type: 'SOUND_STATUS',
        unlocked: true,
      });
      if (result.status === 'rejected') {
        setErrorKey(`errors.${result.reason}`);
      }
    } catch {
      setLocallyUnlocked(false);
      setErrorKey('sound.failed');
      if (canWrite) {
        await session
          .dispatch({ type: 'SOUND_STATUS', unlocked: false })
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="sound-control"
      className="rounded-xl border border-gold-400/20 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-cream-100/80">
          {t('sound.statusLabel')}
        </span>
        <span
          data-testid="sound-status"
          data-unlocked={soundReady}
          className={
            soundReady
              ? 'rounded-full border border-emerald-400/50 px-3 py-1 text-xs text-emerald-200'
              : 'rounded-full border border-gold-400/30 px-3 py-1 text-xs text-gold-300'
          }
        >
          {soundReady ? t('sound.unlocked') : t('sound.locked')}
        </span>
      </div>
      {!soundReady && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            data-testid="sound-consent"
            onClick={() => {
              void enable();
            }}
            disabled={busy || !canWrite}
            className="rounded-md border border-gold-400/50 bg-gold-500/20 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? t('settings.saving') : t('sound.consentButton')}
          </button>
          <p className="text-xs leading-relaxed text-cream-100/60">
            {t('sound.consentExplainer')}
          </p>
        </div>
      )}
      {errorKey && (
        <p
          data-testid="sound-error"
          role="alert"
          className="mt-2 text-xs text-rose-300"
        >
          {t(errorKey)}
        </p>
      )}
    </section>
  );
}
