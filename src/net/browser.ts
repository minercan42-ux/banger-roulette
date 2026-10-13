import genres from '../content/genres.json';
import { TimeResponseSchema } from '../shared/protocol';
import { systemClock } from './clock';
import type { SessionError } from './errors';
import { IdentityStorageError, loadOrCreateClientId } from './identity';
import { createGameSession, type GameSession } from './session';
import { createSupabaseTransportFactory } from './supabaseTransport';
import type { TransportFactory } from './transport';

interface BrowserEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

const unconfigured: TransportFactory = {
  create() {
    throw new Error('Supabase transport is not configured');
  },
};

async function fetchServerTime(): Promise<number> {
  const response = await fetch('/api/time', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`/api/time responded ${response.status}`);
  }
  return TimeResponseSchema.parse(await response.json()).serverNow;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Retained `clientId`, or `null` when the browser refuses storage. */
function loadIdentity(): string | null {
  try {
    return loadOrCreateClientId(window.localStorage, () => crypto.randomUUID());
  } catch (error) {
    if (error instanceof IdentityStorageError) {
      return null;
    }
    throw error;
  }
}

/**
 * An inert session that reports a fatal error and never sends wire. The empty
 * `clientId` is deliberate: a configuration or storage failure must not mint a
 * usable actor identity.
 */
function inertSession(error: SessionError): GameSession {
  return createGameSession({
    clientId: '',
    connectionId: crypto.randomUUID(),
    transport: unconfigured,
    clock: systemClock,
    fetchServerTime,
    genreCatalogue: genres,
    uuid: () => crypto.randomUUID(),
    configError: error,
  });
}

/**
 * Production session factory. Reads only the two public Vite env values, keeps
 * the `clientId` in `localStorage` (never the game), and mints a fresh
 * per-tab `connectionId`. Identity is loaded before the configuration check so
 * a bad config cannot rotate it; both failures surface as an inert session.
 */
export function createBrowserSession(): GameSession {
  // Vite injects these two public values at build time; the cast documents the
  // boundary and is validated below before any client is created.
  const env = import.meta.env as BrowserEnv;
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const clientId = loadIdentity();
  if (clientId === null) {
    return inertSession('IDENTITY_STORAGE');
  }

  if (
    url === undefined ||
    key === undefined ||
    !isHttpsUrl(url) ||
    !key.startsWith('sb_publishable_')
  ) {
    return inertSession('CONFIGURATION');
  }

  return createGameSession({
    clientId,
    connectionId: crypto.randomUUID(),
    transport: createSupabaseTransportFactory({ url, key }),
    clock: systemClock,
    fetchServerTime,
    genreCatalogue: genres,
    uuid: () => crypto.randomUUID(),
  });
}
