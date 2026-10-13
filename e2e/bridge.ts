/**
 * Test-only WebSocket bridge. It is the *server-side transport authority* for
 * the cross-context browser harness: every browser tab opens a socket, the
 * bridge creates the matching real `RoomTransport` from a single shared
 * `InMemoryHub`, and then only relays the public transport surface. No game
 * logic, no schema re-implementation and no fake protocol live here.
 *
 * This file is loaded exclusively by `e2e/vite.config.ts`; the production Vite
 * build never sees it.
 */
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Presence } from '../src/shared/protocol';
import { InMemoryHub } from '../src/net/inMemory';
import type { RoomTransport, SendStatus } from '../src/net/transport';
import {
  BRIDGE_PATH,
  type BridgeFrame,
  type BridgeRequest,
} from './bridge-protocol';

interface Session {
  transport: RoomTransport | null;
  unsubscribe: Array<() => void>;
}

function send(socket: WebSocket, frame: BridgeFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function forward(socket: WebSocket, transport: RoomTransport): () => void {
  const offEvent = transport.onEvent((payload) =>
    send(socket, { kind: 'event', payload }),
  );
  const offReconnect = transport.onReconnect(() =>
    send(socket, { kind: 'reconnect' }),
  );
  const offDisconnect = transport.onDisconnect(() =>
    send(socket, { kind: 'disconnect' }),
  );
  const offPresence = transport.onPresence(() =>
    send(socket, {
      kind: 'presence',
      payloads: transport.presencePayloads(),
    }),
  );
  return () => {
    offEvent();
    offReconnect();
    offDisconnect();
    offPresence();
  };
}

type BridgeValue = SendStatus | Presence[] | undefined;

async function handle(
  session: Session,
  hub: InMemoryHub,
  socket: WebSocket,
  request: BridgeRequest,
): Promise<void> {
  const reply = (value?: BridgeValue): void =>
    send(socket, {
      kind: 'result',
      requestId: request.requestId,
      ok: true,
      value,
    });
  switch (request.op) {
    case 'connect': {
      const transport = hub.create(request.roomCode, {
        clientId: request.clientId,
        connectionId: request.connectionId,
      });
      await transport.connect();
      session.transport = transport;
      session.unsubscribe.push(forward(socket, transport));
      // Presence must reach the client before it resolves its connect call, so
      // the synchronous `presencePayloads()` cache is populated in time.
      send(socket, {
        kind: 'presence',
        payloads: transport.presencePayloads(),
      });
      reply();
      return;
    }
    case 'awaitPresence': {
      await session.transport?.awaitPresence();
      const transport = session.transport;
      if (transport) {
        send(socket, {
          kind: 'presence',
          payloads: transport.presencePayloads(),
        });
      }
      reply();
      return;
    }
    case 'send':
      reply(await session.transport?.send(request.event));
      return;
    case 'track':
      reply(await session.transport?.track(request.presence));
      return;
    case 'untrack':
      await session.transport?.untrack();
      reply();
      return;
    case 'presencePayloads':
      reply(session.transport?.presencePayloads());
      return;
    case 'disconnect':
      await session.transport?.disconnect();
      reply();
      return;
  }
}

/**
 * Attaches the bridge to the test-only Vite HTTP server. `noServer` mode keeps
 * the bridge from destroying Vite's own HMR upgrades: only requests for the
 * bridge path are claimed, everything else is left to Vite.
 */
export function attachBridge(server: Server): void {
  const hub = new InMemoryHub();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const path = request.url?.split('?')[0];
    if (path !== BRIDGE_PATH) return;
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });
  wss.on('connection', (socket) => {
    const session: Session = { transport: null, unsubscribe: [] };
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw)) as BridgeRequest;
      void handle(session, hub, socket, request).catch((error: unknown) => {
        send(socket, {
          kind: 'result',
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    socket.on('close', () => {
      for (const off of session.unsubscribe) off();
      void session.transport?.disconnect();
    });
  });
}
