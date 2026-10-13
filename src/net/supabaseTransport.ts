import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import {
  PresenceSchema,
  type NetworkEvent,
  type Presence,
} from '../shared/protocol';
import type {
  RoomTransport,
  SendStatus,
  TransportFactory,
  TransportIdentity,
} from './transport';

export const BROADCAST_EVENT = 'net';

export interface SupabaseTransportOptions {
  url: string;
  key: string;
  /** Push timeout in ms; SDK default is 10_000. */
  sendTimeoutMs?: number;
  /** Bounded wait for the first full presence sync after subscribing. */
  presenceSettleMs?: number;
}

interface PresenceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

/**
 * Per-topic barrier so a new channel for a room code waits until the previous
 * channel with that topic has been removed. `client.channel(topic)` returns an
 * existing channel with the same topic, so without this a quick leave/rejoin
 * would hand back the old, already-subscribed channel (stale bindings and a
 * subscribe error). Bounded to the single in-flight removal per topic.
 */
interface RemovalBarrier {
  pending(roomCode: string): Promise<void>;
  register(roomCode: string, removal: Promise<void>): void;
}

function toSendStatus(response: string): SendStatus {
  if (response === 'ok') {
    return 'ok';
  }
  return response === 'timed out' ? 'timeout' : 'error';
}

async function createSupabaseClient(
  options: SupabaseTransportOptions,
): Promise<SupabaseClient> {
  // Dynamic import is required by SPEC M2: the SDK must stay out of the initial
  // bundle and is created lazily on the first user action. A static import
  // cannot express that boundary. Types come from the SDK, not hand-rolled
  // structural shapes.
  const module = await import('@supabase/supabase-js');
  return module.createClient(options.url, options.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Public-channel adapter: one topic per room code, `self:false`/`ack:true`
 * broadcast, presence keyed by `${clientId}:${connectionId}`. The SDK is
 * imported lazily and the client is shared per factory so a room-code redraw
 * reuses one socket after the old channel is removed.
 */
class SupabaseTransport implements RoomTransport {
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  private presenceSettled = false;
  private readonly eventListeners = new Set<(payload: unknown) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly presenceListeners = new Set<() => void>();
  private readonly presenceWaiters = new Set<PresenceWaiter>();

  constructor(
    private readonly getClient: () => Promise<SupabaseClient>,
    readonly roomCode: string,
    private readonly identity: TransportIdentity,
    private readonly options: SupabaseTransportOptions,
    private readonly barrier: RemovalBarrier,
  ) {}

  get connectionId(): string {
    return this.identity.connectionId;
  }

  async connect(): Promise<void> {
    const client = await this.getClient();
    // Wait for any previous same-topic channel to be fully removed; otherwise
    // the SDK would return that existing channel instead of a fresh one.
    await this.barrier.pending(this.roomCode);
    const channel = client.channel(`room:${this.roomCode}`, {
      config: {
        broadcast: { self: false, ack: true },
        presence: {
          key: `${this.identity.clientId}:${this.identity.connectionId}`,
        },
        private: false,
      },
    });
    this.channel = channel;

    channel.on<Record<string, unknown>>(
      'broadcast',
      { event: BROADCAST_EVENT },
      (message) => {
        const payload = message.payload;
        for (const listener of this.eventListeners) {
          listener(payload);
        }
      },
    );
    // Only a full sync is authoritative: partial join/leave reconciliation
    // must not drive host elections.
    channel.on('presence', { event: 'sync' }, () => this.settlePresence());

    // The SUBSCRIBED callback re-fires when the SDK silently rejoins after a
    // reconnect, so this idempotent callback is the reconnect signal; error
    // states mark the channel unusable until the rejoin. No heartbeat polling.
    await new Promise<void>((resolve, reject) => {
      let first = true;
      channel.subscribe((status, error) => {
        const state: string = status;
        if (state === 'SUBSCRIBED') {
          this.subscribed = true;
          this.presenceSettled = false;
          if (first) {
            first = false;
            resolve();
          } else {
            for (const listener of this.reconnectListeners) {
              listener();
            }
          }
          return;
        }
        if (
          state === 'CHANNEL_ERROR' ||
          state === 'TIMED_OUT' ||
          state === 'CLOSED'
        ) {
          this.subscribed = false;
          if (first) {
            reject(new Error(error?.message ?? state));
          } else {
            for (const listener of this.disconnectListeners) {
              listener();
            }
          }
        }
      });
    });
  }

  /**
   * Resolves once a full presence sync has been received. If none arrives
   * within the bounded window the call rejects, so discovery never proceeds
   * blind to an unread presence state.
   */
  async awaitPresence(): Promise<void> {
    if (this.presenceSettled) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: PresenceWaiter = { resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => {
        this.presenceWaiters.delete(waiter);
        reject(new Error('Presence sync timed out'));
      }, this.options.presenceSettleMs ?? 1500) as unknown as number;
      this.presenceWaiters.add(waiter);
    });
  }

  isConnected(): boolean {
    return this.subscribed;
  }

  async send(event: NetworkEvent): Promise<SendStatus> {
    // Never send while unjoined: the SDK would fall back to a REST push.
    if (!this.subscribed || this.channel === null) {
      return 'error';
    }
    const response = await this.channel.send(
      { type: 'broadcast', event: BROADCAST_EVENT, payload: event },
      { timeout: this.options.sendTimeoutMs ?? 10000 },
    );
    return toSendStatus(response);
  }

  async track(presence: Presence): Promise<SendStatus> {
    if (!this.subscribed || this.channel === null) {
      return 'error';
    }
    return toSendStatus(
      await this.channel.track({
        protocolVersion: presence.protocolVersion,
        clientId: presence.clientId,
        connectionId: presence.connectionId,
        roomId: presence.roomId,
      }),
    );
  }

  async untrack(): Promise<void> {
    const channel = this.channel;
    // Only a joined channel can remove presence. On a not-joined channel the SDK
    // buffers the untrack push and waits out the send timeout (10 s), which
    // would stall the teardown and let a same-code channel be reused; the server
    // already drops our presence when the socket closes.
    if (channel === null || !this.subscribed || channel.state !== 'joined') {
      return;
    }
    await channel.untrack();
  }

  presencePayloads(): Presence[] {
    if (this.channel === null) {
      return [];
    }
    const state = this.channel.presenceState<Record<string, unknown>>();
    const payloads: Presence[] = [];
    for (const entries of Object.values(state)) {
      for (const entry of entries) {
        const parsed = PresenceSchema.safeParse({
          protocolVersion: entry.protocolVersion,
          clientId: entry.clientId,
          connectionId: entry.connectionId,
          roomId: entry.roomId,
        });
        if (parsed.success) {
          payloads.push(parsed.data);
        }
      }
    }
    return payloads;
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
    const channel = this.channel;
    this.channel = null;
    this.subscribed = false;
    this.presenceSettled = false;
    if (channel === null) {
      return;
    }
    // Unsubscribe and remove this exact channel before a same-code channel can
    // be created: `client.channel(topic)` returns an existing channel with the
    // same topic, so a lingering one would be reused with stale bindings and a
    // subscribe error. Register the removal synchronously so a concurrent
    // same-code connect waits for it rather than reusing the old channel.
    const removal = this.unsubscribeChannel(channel);
    this.barrier.register(this.roomCode, removal);
    await removal;
    const client = await this.getClient();
    if (client.realtime.getChannels().length === 0) {
      await client.realtime.disconnect();
    }
  }

  /** Unsubscribes, removes and tears down the captured channel. */
  private async unsubscribeChannel(channel: RealtimeChannel): Promise<void> {
    const client = await this.getClient();
    await client.realtime.removeChannel(channel);
    channel.teardown();
  }

  private settlePresence(): void {
    this.presenceSettled = true;
    for (const waiter of this.presenceWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.presenceWaiters.clear();
    for (const listener of this.presenceListeners) {
      listener();
    }
  }
}

export function createSupabaseTransportFactory(
  options: SupabaseTransportOptions,
): TransportFactory {
  let clientPromise: Promise<SupabaseClient> | null = null;
  const getClient = (): Promise<SupabaseClient> => {
    clientPromise ??= createSupabaseClient(options);
    return clientPromise;
  };
  const removals = new Map<string, Promise<void>>();
  const barrier: RemovalBarrier = {
    pending(roomCode) {
      const removal = removals.get(roomCode);
      if (removal === undefined) {
        return Promise.resolve();
      }
      // A failed removal must not block a fresh connect; the channel is torn
      // down regardless, so treat it as settled.
      return removal.then(
        () => undefined,
        () => undefined,
      );
    },
    register(roomCode, removal) {
      removals.set(roomCode, removal);
      const clean = (): void => {
        if (removals.get(roomCode) === removal) {
          removals.delete(roomCode);
        }
      };
      void removal.then(clean, clean);
    },
  };
  return {
    create(roomCode: string, identity: TransportIdentity): RoomTransport {
      return new SupabaseTransport(
        getClient,
        roomCode,
        identity,
        options,
        barrier,
      );
    },
  };
}
