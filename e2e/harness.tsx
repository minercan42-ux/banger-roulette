/**
 * Test-only browser entry. It renders the real `Shell` with a real
 * `createGameSession` whose transport is the WebSocket bridge, so every e2e
 * scenario runs the actual UI, the actual session logic and the actual engine.
 * Nothing here is part of the production build; the production entry stays
 * `/src/main.tsx`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import genres from '../src/content/genres.json';
import type { ClientAction } from '../src/shared/actions';
import type { Genre } from '../src/shared/primitives';
import { TimeResponseSchema } from '../src/shared/protocol';
import { systemClock } from '../src/net/clock';
import type { CommandResult } from '../src/net/errors';
import { loadOrCreateClientId } from '../src/net/identity';
import {
  createGameSession,
  type GameSession,
  type SessionSnapshot,
} from '../src/net/session';
import { Shell } from '../src/ui/Shell';
import { createBridgeTransportFactory } from './harness-transport';

async function fetchServerTime(): Promise<number> {
  const response = await fetch('/api/time', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`/api/time responded ${response.status}`);
  }
  return TimeResponseSchema.parse(await response.json()).serverNow;
}

/** Surface exposed to Playwright so tests drive the real session, not a mock. */
export interface HarnessApi {
  session: GameSession;
  snapshot: () => SessionSnapshot;
  dispatch: (action: ClientAction) => Promise<CommandResult>;
}

declare global {
  interface Window {
    __banger?: HarnessApi;
  }
}

// The same client id is retained per browser context, so a reload or a second
// tab in that context shares the identity exactly like production does.
const session = createGameSession({
  clientId: loadOrCreateClientId(window.localStorage, () =>
    crypto.randomUUID(),
  ),
  connectionId: crypto.randomUUID(),
  transport: createBridgeTransportFactory(),
  clock: systemClock,
  fetchServerTime,
  genreCatalogue: genres as Genre[],
  uuid: () => crypto.randomUUID(),
});

window.__banger = {
  session,
  snapshot: () => session.getSnapshot(),
  dispatch: (action) => session.dispatch(action),
};

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Shell session={session} />
  </StrictMode>,
);
