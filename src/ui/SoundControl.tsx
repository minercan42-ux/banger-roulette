import { useTranslation } from 'react-i18next';
import { Badge } from './pf/Badge';
import { Button } from './pf/Button';
import { Panel } from './pf/Panel';
import type { SoundUnlock } from './useSoundUnlock';

interface SoundControlProps {
  sound: SoundUnlock;
  canWrite: boolean;
}

/**
 * FR-07 consent control. Presentation only: the unlock state and the shared
 * AudioContext live in `useSoundUnlock` (room lifetime), so this component may
 * unmount and remount when the layout moves it without losing the permission.
 */
export function SoundControl({ sound, canWrite }: SoundControlProps) {
  const { t } = useTranslation();
  const { soundReady, busy, errorKey, enable } = sound;

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
