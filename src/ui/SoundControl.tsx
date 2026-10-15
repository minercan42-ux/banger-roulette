import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GameSession } from '../net/session';
import { releaseAudioContext, unlockAudioContext } from './audio-context';
import { Badge } from './pf/Badge';
import { Button } from './pf/Button';
import { Panel } from './pf/Panel';

interface SoundControlProps {
  session: GameSession;
  canWrite: boolean;
  unlocked: boolean;
}

/**
 * FR-07 local audio unlock. The consent click really resumes an AudioContext
 * and only then reports SOUND_STATUS. It proves the browser permits audio, not
 * YouTube autoplay: only an actual PLAYING event does that (M4 player). Any
 * failure resets to `false`.
 */
export function SoundControl({
  session,
  canWrite,
  unlocked,
}: SoundControlProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
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

  // Leaving the room drops the shared context the sfx director plays on; a
  // later consent click in the next room creates a fresh one.
  useEffect(() => () => releaseAudioContext(), []);

  async function enable() {
    if (busy || !canWrite || soundReady) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await unlockAudioContext();
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
    <Panel as="section" data-testid="sound-control" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="br-label">{t('sound.statusLabel')}</span>
        <Badge
          data-testid="sound-status"
          data-unlocked={soundReady}
          tone={soundReady ? 'green' : 'slate'}
          dot={soundReady}
        >
          {soundReady ? t('sound.unlocked') : t('sound.locked')}
        </Badge>
      </div>
      {!soundReady && (
        <div className="space-y-2">
          <Button
            data-testid="sound-consent"
            onClick={() => {
              void enable();
            }}
            disabled={busy || !canWrite}
          >
            {busy ? t('settings.saving') : t('sound.consentButton')}
          </Button>
          <p className="br-read">{t('sound.consentExplainer')}</p>
        </div>
      )}
      {errorKey && (
        <p
          data-testid="sound-error"
          role="alert"
          className="br-read text-red-text"
        >
          {t(errorKey)}
        </p>
      )}
    </Panel>
  );
}
