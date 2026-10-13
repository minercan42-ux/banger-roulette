import type { NetworkEvent, Presence } from '../shared/protocol';

export type SendStatus = 'ok' | 'timeout' | 'error';

/** Identity bound to a transport instance (one writable connection per tab). */
export interface TransportIdentity {
  clientId: string;
  connectionId: string;
}

/**
 * A single public room channel. The session layer speaks only in validated
 * `NetworkEvent` frames and full presence payloads; the transport never
 * inspects game semantics.
 */
export interface RoomTransport {
  readonly roomCode: string;
  readonly connectionId: string;
  /** Subscribe to the room topic; resolves once the channel is `SUBSCRIBED`. */
  connect(): Promise<void>;
  /** Resolves after the first presence sync (or a bounded settle timeout). */
  awaitPresence(): Promise<void>;
  isConnected(): boolean;
  send(event: NetworkEvent): Promise<SendStatus>;
  /** Raw broadcast payloads; the session validates them against the schema. */
  onEvent(listener: (payload: unknown) => void): () => void;
  /** Fires when the SDK silently re-joined after a reconnect. */
  onReconnect(listener: () => void): () => void;
  /** Fires when the channel errors or drops; sends must stop until rejoin. */
  onDisconnect(listener: () => void): () => void;
  track(presence: Presence): Promise<SendStatus>;
  untrack(): Promise<void>;
  /** Validated presence payloads of every present client (all tabs). */
  presencePayloads(): Presence[];
  onPresence(listener: () => void): () => void;
  disconnect(): Promise<void>;
}

export interface TransportFactory {
  create(roomCode: string, identity: TransportIdentity): RoomTransport;
}
