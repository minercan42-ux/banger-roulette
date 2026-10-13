import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { GameSession, SessionSnapshot } from '../net/session';

/**
 * Subscribes to the net session. `getSnapshot` returns a stable identity until
 * the session actually changes, so no derived caching is needed here.
 */
export function useSessionSnapshot(session: GameSession): SessionSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type Route = { kind: 'home' } | { kind: 'room'; code: string };

/** Parses the current address; only `/r/{code}` is a room deep link. */
export function readRoute(): Route {
  if (typeof window === 'undefined') {
    return { kind: 'home' };
  }
  const path = window.location.pathname.replace(/\/+$/, '');
  const match = /^\/r\/([^/]+)$/.exec(path);
  if (!match) {
    return { kind: 'home' };
  }
  return {
    kind: 'room',
    code: decodeURIComponent(match[1] ?? '').toUpperCase(),
  };
}

export function roomPath(code: string): string {
  return `/r/${encodeURIComponent(code)}`;
}

export interface NavigateOptions {
  replace?: boolean;
}

/** History-backed route state that reacts to browser back/forward. */
export function useRoute(): [
  Route,
  (path: string, options?: NavigateOptions) => void,
] {
  const [route, setRoute] = useState<Route>(() => readRoute());

  useEffect(() => {
    const onPopState = () => {
      setRoute(readRoute());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string, options?: NavigateOptions) => {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== path) {
      if (options?.replace) {
        window.history.replaceState(null, '', path);
      } else {
        window.history.pushState(null, '', path);
      }
    }
    setRoute(readRoute());
  }, []);

  return [route, navigate];
}
