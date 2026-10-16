import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './pf/Button';
import { PanelTitle } from './pf/Panel';
import type { ConsentState } from './embed-consent';

interface StartGateProps {
  /** `undecided` shows the full popup, anything else the one-tap gate. */
  consent: ConsentState;
  /** The audio unlock is running; both buttons wait for it. */
  busy: boolean;
  /** Translation key of the last failed audio unlock, if any. */
  errorKey: string | null;
  onAccept: () => void;
  onDecline: () => void;
  /** Esc on the one-tap gate; the full popup is not dismissable. */
  onDismiss: () => void;
}

/**
 * One start popup, like a cookie banner: the YouTube embedding consent and the
 * audio unlock in a single gesture. The first visit shows the full popup
 * ("Los geht's" / "Ohne Videos"). Once the consent is stored only the audio
 * unlock remains, because browsers demand a gesture per page load, so the gate
 * shrinks to one "Tippen zum Starten" button. Both paths run the unlock inside
 * the click handler that owns the user gesture.
 */
export function StartGate({
  consent,
  busy,
  errorKey,
  onAccept,
  onDecline,
  onDismiss,
}: StartGateProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const full = consent === 'undecided';

  // Focus moves into the dialog and returns to where it was on close.
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  // Focus trap and Esc. Listens on the document so it holds even if focus
  // sits outside the dialog (page body) when the key is pressed.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!full) {
          event.stopPropagation();
          onDismiss();
        }
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const dialog = dialogRef.current;
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof Node) || !dialog?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [full, onDismiss]);

  return (
    <div
      data-testid="start-gate"
      data-mode={full ? 'full' : 'compact'}
      className={full ? 'br-gate' : 'br-gate br-gate--compact'}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-gate-title"
        aria-describedby="start-gate-body"
        className="br-panel br-gate__panel"
      >
        <PanelTitle as="h2" id="start-gate-title">
          {full ? t('gate.title') : t('gate.compactTitle')}
        </PanelTitle>
        <p id="start-gate-body" className="br-read">
          {full ? t('gate.body') : t('gate.compactBody')}
        </p>
        {full && <p className="br-read">{t('gate.privacy')}</p>}
        {errorKey !== null && (
          <p
            data-testid="sound-error"
            role="alert"
            className="br-notice br-notice--error"
          >
            {t(errorKey)}
          </p>
        )}
        <div className="br-gate__actions">
          <Button
            data-testid="start-gate-accept"
            disabled={busy}
            onClick={onAccept}
          >
            {full ? t('gate.accept') : t('gate.compactAccept')}
          </Button>
          {full && (
            <Button
              tone="slate"
              data-testid="start-gate-decline"
              disabled={busy}
              onClick={onDecline}
            >
              {t('gate.decline')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
