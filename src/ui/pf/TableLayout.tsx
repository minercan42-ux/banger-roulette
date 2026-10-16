import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from './cx';

/** Below this width the drawer is a dialog opened from the top bar. */
const PHONE_QUERY = '(max-width: 639px)';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function subscribePhone(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function phoneSnapshot(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(PHONE_QUERY).matches
  );
}

function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, () => false);
}

interface TableLayoutProps {
  /**
   * Top bar content: wordmark (`br-table__brand`), room info
   * (`br-table__meta`) and controls (`br-table__controls`). The drawer button
   * is appended on phones.
   */
  top: ReactNode;
  /** Second top bar row (round, timer, genre); nothing while it is empty. */
  phaseBar?: ReactNode;
  /** Banners above the stage (connection status, errors). */
  notices?: ReactNode;
  /** Roster. Left column from 1024 px, a horizontal strip below. */
  side?: ReactNode;
  /** The current phase. */
  stage: ReactNode;
  /** Host controls, leave room. Sticky at the bottom on phones. */
  actions?: ReactNode;
  /** Rules, sound status: inline from 640 px, a dialog on phones. */
  drawer?: ReactNode;
  /** Privacy notice, visible on every screen. */
  footer: ReactNode;
}

/**
 * Pixel-Filz Spieltisch (issue #86): the full-width frame of every screen.
 *
 *   >= 1024 px  top bar over a `240px | stage` grid, actions under the stage
 *   640-1023    roster strip above the stage, drawer content below it
 *   < 640       sticky top bar, swipeable roster strip, sticky actions bar;
 *               the drawer is a modal dialog opened from the top bar (focus
 *               trap, Esc closes, focus returns to the opener)
 *
 * Placement only: it knows slots, not game state. The drawer stays mounted
 * while closed so its children keep their state and test ids.
 */
export function TableLayout({
  top,
  phaseBar,
  notices,
  side,
  stage,
  actions,
  drawer,
  footer,
}: TableLayoutProps) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const dialogOpen = phone && open;

  // Focus moves into the dialog on open and back to the opener on close.
  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    const opener = toggleRef.current;
    closeRef.current?.focus();
    return () => {
      opener?.focus();
    };
  }, [dialogOpen]);

  // Esc closes; Tab and Shift+Tab wrap inside the dialog.
  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const dialog = drawerRef.current;
      if (dialog === null) {
        return;
      }
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen]);

  const hasDrawer = drawer !== undefined && drawer !== null;

  return (
    <div className="br-table">
      <header className="br-table__top">
        <div className="br-table__bar">
          {top}
          {hasDrawer && (
            <button
              ref={toggleRef}
              type="button"
              data-testid="drawer-toggle"
              aria-haspopup="dialog"
              aria-expanded={dialogOpen}
              aria-controls={drawerId}
              className="br-btn br-btn--sm br-btn--slate br-table__menu"
              onClick={() => setOpen(true)}
            >
              {t('table.drawerOpen')}
            </button>
          )}
        </div>
        {phaseBar !== undefined && phaseBar !== null && (
          <div className="br-table__phase">{phaseBar}</div>
        )}
      </header>

      <div className={cx('br-table__body', side === undefined && 'is-solo')}>
        {side !== undefined && (
          <aside aria-label={t('table.rosterLabel')} className="br-table__side">
            {side}
          </aside>
        )}
        <main className="br-panel br-table__stage">
          {notices}
          {stage}
        </main>
        {actions !== undefined && actions !== null && (
          <section
            aria-label={t('table.actionsLabel')}
            data-testid="table-actions"
            className="br-table__actions"
          >
            {actions}
          </section>
        )}
        {hasDrawer && (
          <>
            {dialogOpen && (
              <div
                aria-hidden="true"
                data-testid="drawer-scrim"
                className="br-table__scrim"
                onClick={() => setOpen(false)}
              />
            )}
            <div
              id={drawerId}
              ref={drawerRef}
              data-testid="table-drawer"
              role={phone ? 'dialog' : 'complementary'}
              aria-modal={dialogOpen ? true : undefined}
              aria-label={t('table.drawerTitle')}
              hidden={phone && !open}
              className={cx('br-table__drawer', dialogOpen && 'is-open')}
            >
              {phone && (
                <div className="br-table__drawer-head">
                  <span className="br-label">{t('table.drawerTitle')}</span>
                  <button
                    ref={closeRef}
                    type="button"
                    data-testid="drawer-close"
                    className="br-btn br-btn--sm br-btn--slate"
                    onClick={() => setOpen(false)}
                  >
                    {t('table.drawerClose')}
                  </button>
                </div>
              )}
              {drawer}
            </div>
          </>
        )}
      </div>

      {footer}
    </div>
  );
}
