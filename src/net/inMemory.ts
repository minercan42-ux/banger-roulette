import type { NetworkEvent, Presence } from '../shared/protocol';
import type {
  RoomTransport,
  SendStatus,
  TransportFactory,
  TransportIdentity,
} from './transport';

interface RoomState {
  transports: Set<InMemoryTransport>;
  presence: Map<string, Presence>;
}

/**
 * Deterministic in-process room network. Multiple sessions share one hub; it
 * delivers broadcasts with `self:false` semantics, tracks presence, and lets
 * tests drop or restore a connection to exercise reconnection and migration.
 * It is the same transport contract the Supabase adapter implements, so no
 * game code needs a test double.
 */
export class InMemoryHub implements TransportFactory {
  private readonly rooms = new Map<string, RoomState>();
  private readonly queue: Array<() => void> = [];
  private draining = false;
  private readonly byConnection = new Map<string, InMemoryTransport>();

  create(roomCode: string, identity: TransportIdentity): RoomTransport {
    const transport = new InMemoryTransport(this, roomCode, identity);
    this.byConnection.set(identity.connectionId, transport);
    return transport;
  }

  /** Presence payloads currently tracked in the room, in insertion order. */
  presencePayloads(roomCode: string): Presence[] {
    return [...(this.rooms.get(roomCode)?.presence.values() ?? [])];
  }

  /** Simulates a socket drop: presence leaves and broadcasts stop arriving. */
  simulateDrop(connectionId: string): void {
    this.byConnection.get(connectionId)?.markDropped();
  }

  /** Simulates the SDK's silent rejoin; the session must re-track presence. */
  simulateRestore(connectionId: string): void {
    this.byConnection.get(connectionId)?.markRestored();
  }

  /** Drops broadcast deliveries to a connection (presence still works). */
  setLossy(connectionId: string, lossy: boolean): void {
    this.byConnection.get(connectionId)?.setLossy(lossy);
  }

  joinRoom(roomCode: string, transport: InMemoryTransport): void {
    let room = this.rooms.get(roomCode);
    if (room === undefined) {
      room = { transports: new Set(), presence: new Map() };
      this.rooms.set(roomCode, room);
    }
    room.transports.add(transport);
  }

  leaveRoom(roomCode: string, transport: InMemoryTransport): void {
    const room = this.rooms.get(roomCode);
    if (room === undefined) {
      return;
    }
    room.transports.delete(transport);
    room.presence.delete(transport.connectionId);
    this.emitPresence(roomCode);
    if (room.transports.size === 0) {
      this.rooms.delete(roomCode);
    }
  }

  broadcast(
    roomCode: string,
    senderConnectionId: string,
    event: NetworkEvent,
  ): void {
    this.enqueue(() => {
      const room = this.rooms.get(roomCode);
      if (room === undefined) {
        return;
      }
      for (const transport of room.transports) {
        if (
          transport.connectionId !== senderConnectionId &&
          transport.isConnected()
        ) {
          transport.receive(event);
        }
      }
    });
  }

  track(roomCode: string, connectionId: string, presence: Presence): void {
    const room = this.rooms.get(roomCode);
    if (room === undefined) {
      return;
    }
    room.presence.set(connectionId, presence);
    this.emitPresence(roomCode);
  }

  untrack(roomCode: string, connectionId: string): void {
    const room = this.rooms.get(roomCode);
    if (room === undefined) {
      return;
    }
    room.presence.delete(connectionId);
    this.emitPresence(roomCode);
  }

  private emitPresence(roomCode: string): void {
    this.enqueue(() => {
      const room = this.rooms.get(roomCode);
      if (room === undefined) {
        return;
      }
      for (const transport of room.transports) {
        if (transport.isConnected()) {
          transport.notifyPresence();
        }
      }
    });
  }

  private enqueue(task: () => void): void {
    this.queue.push(task);
    if (this.draining) {
      return;
    }
    this.draining = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
    this.draining = false;
  }
}

class InMemoryTransport implements RoomTransport {
  private connected = false;
  private lossy = false;
  private readonly eventListeners = new Set<(payload: unknown) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly presenceListeners = new Set<() => void>();

  constructor(
    private readonly hub: InMemoryHub,
    readonly roomCode: string,
    private readonly identity: TransportIdentity,
  ) {}

  get connectionId(): string {
    return this.identity.connectionId;
  }

  async connect(): Promise<void> {
    this.hub.joinRoom(this.roomCode, this);
    this.connected = true;
  }

  async awaitPresence(): Promise<void> {
    // Presence is delivered synchronously by the hub; nothing to await.
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(event: NetworkEvent): Promise<SendStatus> {
    if (!this.connected) {
      return 'error';
    }
    this.hub.broadcast(this.roomCode, this.connectionId, event);
    return 'ok';
  }

  async track(presence: Presence): Promise<SendStatus> {
    if (!this.connected) {
      return 'error';
    }
    this.hub.track(this.roomCode, this.connectionId, presence);
    return 'ok';
  }

  async untrack(): Promise<void> {
    this.hub.untrack(this.roomCode, this.connectionId);
  }

  presencePayloads(): Presence[] {
    return this.hub.presencePayloads(this.roomCode);
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

  onPresence(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.hub.leaveRoom(this.roomCode, this);
  }

  receive(event: NetworkEvent): void {
    if (this.lossy) {
      return;
    }
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  setLossy(lossy: boolean): void {
    this.lossy = lossy;
  }

  notifyPresence(): void {
    for (const listener of this.presenceListeners) {
      listener();
    }
  }

  markDropped(): void {
    this.connected = false;
    this.hub.untrack(this.roomCode, this.connectionId);
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  markRestored(): void {
    this.connected = true;
    for (const listener of this.reconnectListeners) {
      listener();
    }
  }
}
