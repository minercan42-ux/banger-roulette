import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectRoster } from '../engine/selectors';
import { REJECTIONS, SESSION_FAILURES, type SessionError } from '../net/errors';
import type { GameSession, SessionSnapshot } from '../net/session';
import './i18n';
import './styles.css';
import { Chip } from './Chip';
import { HomeView } from './HomeView';
import { SUPPORTED_LANGUAGES, type Language } from './language';
import { useLanguageStore } from './language-store';
import { Backdrop } from './pf/Backdrop';
import { RoomView } from './RoomView';
import { roomPath, useRoute, useSessionSnapshot } from './session-hooks';
import { useSfxStore } from './sfx-store';

const ERROR_CODES = new Set<string>([...SESSION_FAILURES, ...REJECTIONS]);

/** Connection/config failures the shell banner owns; form errors stay inline. */
const TRANSPORT_ERRORS = new Set<SessionError>([
  'CONFIGURATION',
  'IDENTITY_STORAGE',
  'CONNECTION_FAILED',
  'CLOCK_SYNC_FAILED',
  'STATE_LOST',
  'COMMAND_TIMEOUT',
]);

function toSessionError(error: unknown): SessionError {
  const value =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : null;
  return value !== null && ERROR_CODES.has(value)
    ? (value as SessionError)
    : 'CONNECTION_FAILED';
}

/** The session is really inside the room only once our JOIN is accepted. */
function selfConnected(snapshot: SessionSnapshot): boolean {
  if (snapshot.state === null) {
    return false;
  }
  return selectRoster(snapshot.state, snapshot.clientId).some(
    (player) => player.isSelf && player.connected,
  );
}

export function Shell({ session }: { session: GameSession }) {
  const { t } = useTranslation();
  const language = useLanguageStore((store) => store.language);
  const setLanguage = useLanguageStore((store) => store.setLanguage);
  const sfxEnabled = useSfxStore((store) => store.enabled);
  const setSfxEnabled = useSfxStore((store) => store.setEnabled);
  const snapshot = useSessionSnapshot(session);
  const [route, navigate] = useRoute();
  const [noticeError, setNoticeError] = useState<SessionError | null>(null);
  const [routeResult, setRouteResult] = useState<{
    code: string;
    identityAbsent: boolean;
  } | null>(null);
  const pendingEnterRef = useRef(false);
  const leavingRef = useRef(false);
  const joinInFlightRef = useRef<string | null>(null);

  const state = snapshot.state;
  const roster = state === null ? null : selectRoster(state, snapshot.clientId);
  const inRoom =
    snapshot.roomCode !== null &&
    roster?.some((player) => player.isSelf) === true;
  const routeCode = route.kind === 'room' ? route.code : null;
  const previousRouteCode = useRef(routeCode);
  const joining =
    routeCode !== null && !inRoom && routeResult?.code !== routeCode;
  const identityMissing =
    routeCode !== null &&
    !inRoom &&
    routeResult?.code === routeCode &&
    routeResult.identityAbsent;

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('app.title');
  }, [language, t]);

  // Deep link: discover a retained identity, otherwise ask for a nickname.
  // No synchronous setState: the failure path runs inside the async callback.
  useEffect(() => {
    if (routeCode === null) {
      joinInFlightRef.current = null;
      return;
    }
    if (inRoom || routeResult?.code === routeCode) {
      return;
    }
    if (joinInFlightRef.current === routeCode) {
      return;
    }
    joinInFlightRef.current = routeCode;
    void (async () => {
      let failure: SessionError | null = null;
      try {
        await session.joinRoom(routeCode, '');
      } catch (error) {
        failure = toSessionError(error);
      }
      if (joinInFlightRef.current !== routeCode) {
        return;
      }
      joinInFlightRef.current = null;
      const next = session.getSnapshot();
      if (next.roomCode !== null && selfConnected(next)) {
        return;
      }
      if (next.roomCode !== null) {
        await session.leave();
      }
      // An absent identity rejects the empty nickname with INVALID; that is
      // the "enter a nickname" signal, not an error to shout about.
      const error = failure ?? next.error;
      const identityAbsent = error === null || error === 'INVALID';
      if (!identityAbsent) {
        setNoticeError(error);
      }
      setRouteResult({ code: routeCode, identityAbsent });
    })();
  }, [routeCode, inRoom, routeResult, session]);

  // Only an actual room-route → home transition leaves the room. A session
  // entering from the landing page must survive until navigation catches up.
  useEffect(() => {
    const wasRoomRoute = previousRouteCode.current !== null;
    previousRouteCode.current = routeCode;
    if (
      routeCode !== null ||
      !wasRoomRoute ||
      !inRoom ||
      pendingEnterRef.current ||
      leavingRef.current
    ) {
      return;
    }
    leavingRef.current = true;
    void (async () => {
      try {
        await session.leave();
      } finally {
        leavingRef.current = false;
        setNoticeError(null);
      }
    })();
  }, [routeCode, inRoom, session]);

  const runEnter = useCallback(
    async (action: () => Promise<void>): Promise<SessionError | null> => {
      pendingEnterRef.current = true;
      setNoticeError(null);
      let actionError: SessionError | null = null;
      try {
        await action();
      } catch (error) {
        actionError = toSessionError(error);
      }
      const next = session.getSnapshot();
      pendingEnterRef.current = false;
      if (
        actionError === null &&
        next.roomCode !== null &&
        selfConnected(next)
      ) {
        navigate(roomPath(next.roomCode));
        return null;
      }
      if (next.roomCode !== null) {
        await session.leave();
      }
      // HomeView owns these errors; the banner is for deep-link discovery.
      return actionError ?? next.error ?? 'CONNECTION_FAILED';
    },
    [session, navigate],
  );

  const leaveToHome = useCallback(() => {
    navigate('/', { replace: true });
  }, [navigate]);

  const bannerError =
    noticeError ??
    (snapshot.error !== null && TRANSPORT_ERRORS.has(snapshot.error)
      ? snapshot.error
      : null);
  const showStatus =
    snapshot.status !== 'idle' && snapshot.status !== 'connected';

  return (
    <div
      data-testid="app-shell"
      className="relative flex min-h-dvh justify-center px-4 py-10 sm:px-6"
    >
      <Backdrop />
      <div className="br-panel relative w-full max-w-2xl p-5 sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex -space-x-2">
              <Chip tone="red" size="md" />
              <Chip tone="gold" size="md" />
              <Chip tone="neon" size="md" />
            </span>
            <span
              data-testid="app-title"
              className="br-logo shell-logo uppercase"
            >
              {t('app.title')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="sfx-toggle"
              aria-pressed={sfxEnabled}
              onClick={() => {
                setSfxEnabled(!sfxEnabled);
              }}
              className={`br-btn br-btn--sm br-btn--slate${sfxEnabled ? ' is-on' : ''}`}
            >
              {sfxEnabled ? t('sfx.on') : t('sfx.off')}
            </button>
            <label htmlFor="language-switch" className="br-label">
              {t('language.label')}
            </label>
            <select
              id="language-switch"
              data-testid="language-switch"
              aria-label={t('language.label')}
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value as Language);
              }}
              className="br-field__input px-2 py-1 text-[20px] leading-[22px]"
            >
              {SUPPORTED_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`language.options.${code}`)}
                </option>
              ))}
            </select>
          </div>
        </header>
        <div aria-hidden="true" className="h-[3px] rounded-full bg-edge" />

        <div className="space-y-4 pt-6">
          {showStatus && (
            <p
              data-testid="session-status"
              data-status={snapshot.status}
              role="status"
              className="rounded-lg border border-gold-400/30 bg-felt-800/60 px-3 py-2 text-sm text-gold-200"
            >
              {t(`status.${snapshot.status}`)}
              {snapshot.status === 'lost' && (
                <>
                  {' '}
                  <button
                    type="button"
                    data-testid="session-lost-home"
                    onClick={leaveToHome}
                    className="underline"
                  >
                    {t('lobby.backHome')}
                  </button>
                </>
              )}
            </p>
          )}

          {bannerError === 'CONFIGURATION' ? (
            <section
              data-testid="config-error"
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-3 text-sm text-rose-100"
            >
              <p className="font-semibold">{t('config.title')}</p>
              <p className="mt-1">{t('config.body')}</p>
            </section>
          ) : (
            bannerError !== null && (
              <p
                data-testid="session-error"
                role="alert"
                className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
              >
                {t(`errors.${bannerError}`)}
              </p>
            )
          )}

          {inRoom && state !== null && roster !== null ? (
            <RoomView
              session={session}
              snapshot={snapshot}
              state={state}
              roster={roster}
              onLeave={leaveToHome}
            />
          ) : (
            <HomeView
              key={routeCode ?? 'home'}
              prefillCode={routeCode}
              joining={joining}
              identityMissing={identityMissing}
              onCreate={(nickname) =>
                runEnter(() => session.createRoom(nickname))
              }
              onJoin={(code, nickname) =>
                runEnter(() => session.joinRoom(code, nickname))
              }
            />
          )}
        </div>

        <footer
          data-testid="privacy-notice"
          aria-label={t('privacy.title')}
          className="mt-6 border-t-[3px] border-edge pt-4 font-text text-[13px] leading-[18px] text-cream-muted"
        >
          <p className="br-label">{t('privacy.title')}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 break-words">
            <li>{t('privacy.embed')}</li>
            <li>{t('privacy.noTracking')}</li>
            <li>{t('privacy.storage')}</li>
          </ul>
        </footer>
      </div>
    </div>
  );
}
