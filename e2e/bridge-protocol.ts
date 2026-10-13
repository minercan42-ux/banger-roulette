/**
 * Test-only frame protocol between the browser harness transport and the
 * Node-side bridge. It mirrors the public `RoomTransport` surface one-to-one so
 * the server bridge can delegate straight into the real in-memory transport and
 * the browser side can implement `RoomTransport` without reimplementing any
 * authority. No production code imports this file.
 */
import type { NetworkEvent, Presence } from '../src/shared/protocol';
import type { SendStatus } from '../src/net/transport';

/** Requests sent browser -> bridge. */
export type BridgeRequest =
  | {
      op: 'connect';
      requestId: number;
      roomCode: string;
      clientId: string;
      connectionId: string;
    }
  | { op: 'awaitPresence'; requestId: number }
  | { op: 'send'; requestId: number; event: NetworkEvent }
  | { op: 'track'; requestId: number; presence: Presence }
  | { op: 'untrack'; requestId: number }
  | { op: 'presencePayloads'; requestId: number }
  | { op: 'disconnect'; requestId: number };

/** Frames pushed bridge -> browser. */
export type BridgeFrame =
  | {
      kind: 'result';
      requestId: number;
      ok: true;
      value?: SendStatus | Presence[];
    }
  | { kind: 'result'; requestId: number; ok: false; error: string }
  | { kind: 'event'; payload: unknown }
  | { kind: 'reconnect' }
  | { kind: 'disconnect' }
  | { kind: 'presence'; payloads: Presence[] };

/** Path the test-only Vite server exposes the bridge on (same origin). */
export const BRIDGE_PATH = '/__banger_bridge';
