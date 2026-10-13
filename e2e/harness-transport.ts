/**
 * Browser-side `RoomTransport` that forwards every call to the test-only
 * WebSocket bridge. The bridge owns the real in-memory hub, so this class holds
 * no game authority: it only proxies connect/send/track/presence and republishes
 * the frames the hub emits. It is never part of the production bundle.
 */
import type { NetworkEvent, Presence } from '../src/shared/protocol';
import type {
  RoomTransport,
  SendStatus,
  TransportFactory,
  TransportIdentity,
} from '../src/net/transport';
import {
  BRIDGE_PATH,
  type BridgeFrame,
  type BridgeRequest,
} from './bridge-protocol';

interface Pending {
  resolve: (value: SendStatus | Presence[] | undefined) => void;
  reject: (error: Error) => void;
}
type BridgeCall = {
  [Op in BridgeRequest['op']]: Omit<
    Extract<BridgeRequest, { op: Op }>,
    'requestId'
  >;
}[BridgeRequest['op']];

class BridgeRoomTransport implements RoomTransport {
  readonly roomCode: string;
  readonly connectionId: string;

  private readonly clientId: string;
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(payload: unknown) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly presenceListeners = new Set<() => void>();
  private presence: Presence[] = [];
  private nextRequestId = 1;
  private connected = false;
  private dropped = false;
  private disposed = false;

  constructor(roomCode: string, identity: TransportIdentity) {
    this.roomCode = roomCode;
    this.connectionId = identity.connectionId;
    this.clientId = identity.clientId;
    this.socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BRIDGE_PATH}`,
    );
    const opened = Promise.withResolvers<void>();
    this.ready = opened.promise;
    this.socket.addEventListener('open', () => opened.resolve());
    this.socket.addEventListener('error', () =>
      opened.reject(new Error('bridge socket failed')),
    );
    this.socket.addEventListener('message', (event) => {
      this.handleFrame(JSON.parse(String(event.data)) as BridgeFrame);
    });
    this.socket.addEventListener('close', () => this.handleClose());
  }

  private handleFrame(frame: BridgeFrame): void {
    switch (frame.kind) {
      case 'result': {
        const pending = this.pending.get(frame.requestId);
        if (!pending) return;
        this.pending.delete(frame.requestId);
        if (frame.ok) {
          pending.resolve(frame.value);
        } else {
          pending.reject(new Error(frame.error));
        }
        return;
      }
      case 'event':
        for (const listener of this.eventListeners) listener(frame.payload);
        return;
      case 'reconnect':
        this.dropped = false;
        for (const listener of this.reconnectListeners) listener();
        return;
      case 'disconnect':
        this.markDropped();
        return;
      case 'presence':
        this.presence = frame.payloads;
        for (const listener of this.presenceListeners) listener();
        return;
    }
  }

  /** Marks the proxied channel dropped once and notifies the session. */
  private markDropped(): void {
    if (this.dropped || this.disposed) return;
    this.dropped = true;
    this.connected = false;
    for (const listener of this.disconnectListeners) listener();
  }

  private handleClose(): void {
    this.markDropped();
    const error = new Error('bridge socket closed');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async request<T extends SendStatus | Presence[] | undefined>(
    request: BridgeCall,
  ): Promise<T> {
    if (this.disposed) throw new Error('transport disposed');
    await this.ready;
    const requestId = this.nextRequestId++;
    const deferred = Promise.withResolvers<
      SendStatus | Presence[] | undefined
    >();
    this.pending.set(requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    this.socket.send(JSON.stringify({ ...request, requestId }));
    return deferred.promise as Promise<T>;
  }

  async connect(): Promise<void> {
    await this.request({
      op: 'connect',
      roomCode: this.roomCode,
      clientId: this.clientId,
      connectionId: this.connectionId,
    });
    this.connected = true;
    this.dropped = false;
  }

  async awaitPresence(): Promise<void> {
    await this.request({ op: 'awaitPresence' });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(event: NetworkEvent): Promise<SendStatus> {
    if (!this.connected) return 'error';
    return (await this.request<SendStatus>({ op: 'send', event })) ?? 'error';
  }

  onEvent(listener: (payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async track(presence: Presence): Promise<SendStatus> {
    if (!this.connected) return 'error';
    return (
      (await this.request<SendStatus>({ op: 'track', presence })) ?? 'error'
    );
  }

  async untrack(): Promise<void> {
    await this.request({ op: 'untrack' });
  }

  presencePayloads(): Presence[] {
    return [...this.presence];
  }

  onPresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.request({ op: 'disconnect' });
    } catch {
      // The bridge may already be gone; closing the socket is enough.
    }
    this.disposed = true;
    this.connected = false;
    this.socket.close();
  }
}

/** Factory handed to `createGameSession` so the real session runs over the bridge. */
export function createBridgeTransportFactory(): TransportFactory {
  return {
    create: (roomCode, identity) => new BridgeRoomTransport(roomCode, identity),
  };
}
