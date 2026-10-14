import type { ClientAction } from '../shared/actions';
import type { GameState } from '../shared/game';
import { Nickname, RoomCode, type Genre } from '../shared/primitives';
import {
  NetworkEventSchema,
  type NetworkEvent,
  type Presence,
} from '../shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import {
  classifyCommand,
  createInitialState,
  electHost,
  reducer,
} from '../engine';
import {
  ChunkError,
  DEFAULT_CHUNK_LIMITS,
  Reassembler,
  encodeEvent,
  type ChunkLimits,
} from './chunk';
import { ClockSync, type NetClock } from './clock';
import type { CommandResult, SessionError, SessionStatus } from './errors';
import { RateLimiter } from './rateLimit';
import { PacedSender } from './sendQueue';
import type { RoomTransport, SendStatus, TransportFactory } from './transport';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_CREATE_ATTEMPTS = 5;
/**
 * One automatic retry of the first create/join on a transient Realtime failure
 * (a Presence tuple that is not live yet, or a thrown transport/presence
 * error). Terminal failures and an exhausted code-collision loop are never
 * retried; a newer create/join cancels a pending retry.
 */
const TRANSIENT_RETRY_LIMIT = 1;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 4000;
const DEFAULT_MIGRATION_COLLECT_MS = 250;
const DEFAULT_COMMAND_TIMEOUT_MS = 8000;
const DEFAULT_RESYNC_TIMEOUT_MS = 6000;
const SEND_RETRY_MS = 1000;
/** Minimum spacing between resync requests to avoid an attacker-driven flood. */
const RESYNC_THROTTLE_MS = 1000;
/**
 * Fanout-aware snapshot burst bound. Delivered messages count against the
 * shared project budget, so a room paces at `budget / recipients` frames per
 * second. This bounds only this room's snapshot burst; commands, results,
 * ACKs and other rooms consume the same budget and are not accounted here.
 */
const MESSAGE_BUDGET_PER_SECOND = 100;
/** Per-client command budget: 10 commands/second with a burst of 20. */
const DEFAULT_RATE_LIMIT = { burst: 20, perSecond: 10 };
/** Global per-room budget for answering discovery/resync requests. */
const STATE_REQUEST_BUDGET = { burst: 8, perSecond: 4 };
/** Extra settle window used to pick the canonical room on a code collision. */
const CANONICAL_SETTLE_MS = 200;

type WireBody = NetworkEvent['body'];
type WireCommandResult = Extract<
  WireBody,
  { type: 'COMMAND_RESULT' }
>['result'];

export interface SessionClockView {
  offsetMs: number;
  rttMs: number | null;
  synchronized: boolean;
}

/** Immutable view of the session; identity is stable until something changes. */
export interface SessionSnapshot {
  status: SessionStatus;
  state: GameState | null;
  clientId: string;
  connectionId: string;
  roomCode: string | null;
  error: SessionError | null;
  pendingCommands: number;
  clock: SessionClockView;
}

export interface GameSession {
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  createRoom(nickname: string): Promise<void>;
  joinRoom(code: string, nickname: string): Promise<void>;
  dispatch(action: ClientAction): Promise<CommandResult>;
  leave(): Promise<void>;
  now(): number;
  dispose(): Promise<void>;
}

export interface GameSessionOptions {
  clientId: string;
  connectionId: string;
  transport: TransportFactory;
  clock: NetClock;
  /** Same-origin `/api/time`; the session never fabricates server time. */
  fetchServerTime: () => Promise<number>;
  genreCatalogue: Genre[];
  uuid?: () => string;
  settings?: Settings;
  clockSamples?: number;
  discoveryTimeoutMs?: number;
  migrationCollectMs?: number;
  commandTimeoutMs?: number;
  resyncTimeoutMs?: number;
  rateLimit?: { burst: number; perSecond: number };
  chunkLimits?: Partial<ChunkLimits>;
  /** Surfaces a fatal configuration problem (e.g. missing Vite env). */
  configError?: SessionError;
  onLog?: (message: string, detail?: unknown) => void;
}

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  timer: number;
  /** Accepted version the state must reach before the promise resolves. */
  version?: number;
}

interface EnvelopeOverrides {
  roomCode?: string;
  roomId?: string | null;
  hostEpoch?: number;
  sentAt?: number;
}

/** A migration claim we observed, scoped so it cannot escalate the epoch. */
interface PendingClaim {
  oldEpoch: number;
  newEpoch: number;
  candidateId: string;
  connectionId: string;
  baseVersion: number;
  at: number;
}

/** A migration claim is only trusted for a short window after observation. */
const MIGRATION_CLAIM_TTL_MS = 5000;

function randomRoomCode(uuid: () => string): string {
  const hex = uuid().replace(/-/g, '');
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function randomSeed(uuid: () => string): number {
  const value = Number.parseInt(uuid().replace(/-/g, '').slice(0, 8), 16) >>> 0;
  return value === 0 ? 1 : value;
}

/** Whether this exact tab is the state's currently bound host connection. */
function isSelfBoundHost(
  state: GameState,
  clientId: string,
  connectionId: string,
): boolean {
  return (
    state.hostId === clientId &&
    state.players[state.hostId]?.connectionId === connectionId
  );
}

/** Mirrors the schema's designated replica: oldest connected non-host player. */
function designatedReplicaId(state: GameState): string | null {
  const replica = Object.values(state.players)
    .filter(
      (player) =>
        player.id !== state.hostId &&
        player.connected &&
        player.status !== 'kicked' &&
        player.status !== 'left',
    )
    .sort(
      (a, b) =>
        a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
  return replica?.id ?? null;
}

/**
 * Host-authoritative session over a `RoomTransport`. It owns the engine for the
 * host tab, applies validated snapshots elsewhere, schedules real deadlines,
 * resolves command results explicitly, and drives deterministic host migration.
 */
class NetworkGameSession implements GameSession {
  private readonly clientId: string;
  private readonly connectionId: string;
  private readonly uuid: () => string;
  private readonly clock: NetClock;
  private readonly factory: TransportFactory;
  private readonly clockSync: ClockSync;
  private readonly genreCatalogue: Genre[];
  private readonly settings: Settings;
  private readonly chunkLimits: ChunkLimits;
  private readonly reassembler: Reassembler;
  private readonly sender: PacedSender;
  private readonly rateLimiter: RateLimiter;
  /** Free tier allows 5 presence calls per client per 30 s. */
  private readonly presenceLimiter = new RateLimiter(5, 5 / 30);
  private readonly discoveryTimeoutMs: number;
  private readonly migrationCollectMs: number;
  private readonly commandTimeoutMs: number;
  private readonly resyncTimeoutMs: number;
  private readonly configError: SessionError | null;
  private readonly log: (message: string, detail?: unknown) => void;

  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingCommand>();
  /** Global per-room budget for answering discovery/resync requests. */
  private readonly stateRequestLimiter = new RateLimiter(
    STATE_REQUEST_BUDGET.burst,
    STATE_REQUEST_BUDGET.perSecond,
  );
  /** Per-sender budget so one connection cannot amplify requests. */
  private readonly stateRequestSenderLimiter = new RateLimiter(
    STATE_REQUEST_BUDGET.burst,
    STATE_REQUEST_BUDGET.perSecond,
  );

  private transport: RoomTransport | null = null;
  private state: GameState | null = null;
  private mode: 'idle' | 'host' | 'client' = 'idle';
  private status: SessionStatus = 'idle';
  private error: SessionError | null = null;
  private roomCode: string | null = null;
  private roomId: string | null = null;

  /** Monotonic lifecycle token; async continuations abort when it changes. */
  private generation = 0;
  private claiming = false;
  private rejoining = false;
  private discoveryResolver: ((event: NetworkEvent) => void) | null = null;
  /** Terminal resolver of the in-flight discovery, so teardown can end it. */
  private discoveryResolve: ((state: GameState | null) => void) | null = null;
  /** Local timers owned by the in-flight discovery, cleared on cancel. */
  private discoveryTimers: number[] = [];
  private migrationOldEpoch = 0;
  private claimSnapshots = new Map<string, GameState>();
  /**
   * The one migration claim we observed, scoped to the exact epoch step,
   * candidate binding and base version, and expiring on adopt/abort/epoch/room
   * change or a short TTL. A sticky set of sender ids would let any observed
   * claimer escalate the epoch arbitrarily and indefinitely.
   */
  private pendingClaim: PendingClaim | null = null;
  /** Logical version of the room-broadcast SNAPSHOT currently queued/in flight. */
  private pendingSnapshotVersion: number | null = null;
  /** Set when a rejoining host saw an epoch beyond its own; blocks stale reclaim. */
  private rejoinHigherEpoch = false;
  private joinWaiter: {
    version: number;
    resolve: (converged: boolean) => void;
    timer: number;
  } | null = null;
  private lastAck: { clientId: string; stateVersion: number } | null = null;
  private ackedVersion = -1;
  private lastResyncAt = -1;

  private deadlineTimer = 0;
  private migrationTimer = 0;
  private migrationAbortTimer = 0;
  private resyncTimer = 0;
  private republishTimer = 0;
  private reclaimTimer = 0;

  private dirty = true;
  private cached: SessionSnapshot | null = null;
  private disposed = false;

  constructor(options: GameSessionOptions) {
    this.clientId = options.clientId;
    this.connectionId = options.connectionId;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.clock = options.clock;
    this.factory = options.transport;
    this.genreCatalogue = options.genreCatalogue;
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.chunkLimits = { ...DEFAULT_CHUNK_LIMITS, ...options.chunkLimits };
    this.reassembler = new Reassembler(this.clock, this.chunkLimits);
    const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.rateLimiter = new RateLimiter(rateLimit.burst, rateLimit.perSecond);
    this.sender = new PacedSender(this.clock, {
      framesPerSecond: () => this.framesPerSecond(),
      send: (event) => this.transport?.send(event) ?? Promise.resolve('error'),
      onFailure: () => this.noteSendFailure(),
      // A room-broadcast snapshot is only "in flight" until its whole batch
      // (all chunks) has drained; then a newer request may publish again.
      onIdle: () => {
        this.pendingSnapshotVersion = null;
      },
    });
    this.discoveryTimeoutMs =
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.migrationCollectMs =
      options.migrationCollectMs ?? DEFAULT_MIGRATION_COLLECT_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.resyncTimeoutMs = options.resyncTimeoutMs ?? DEFAULT_RESYNC_TIMEOUT_MS;
    this.configError = options.configError ?? null;
    this.log = options.onLog ?? (() => undefined);
    if (this.configError !== null) {
      this.error = this.configError;
      this.status = 'error';
    }
    this.clockSync = new ClockSync({
      fetchServerTime: options.fetchServerTime,
      localNow: () => this.clock.now(),
      samples: options.clockSamples,
    });
  }

  getSnapshot(): SessionSnapshot {
    if (!this.dirty && this.cached !== null) {
      return this.cached;
    }
    this.cached = {
      status: this.status,
      state: this.state,
      clientId: this.clientId,
      connectionId: this.connectionId,
      roomCode: this.roomCode,
      error: this.error,
      pendingCommands: this.pending.size,
      clock: {
        offsetMs: this.clockSync.offsetMs,
        rttMs: this.clockSync.rttMs,
        synchronized: this.clockSync.isSynchronized,
      },
    };
    this.dirty = false;
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  now(): number {
    return this.clockSync.serverNow();
  }

  async createRoom(nickname: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.configError !== null) {
      this.error = this.configError;
      this.status = 'error';
      this.markChanged();
      return;
    }
    if (!Nickname.safeParse(nickname).success) {
      await this.closeTransport(this.teardownRoom());
      this.fail('INVALID');
      return;
    }
    await this.closeTransport(this.teardownRoom());
    const generation = this.generation;
    this.setStatus('connecting');
    for (let retry = 0; retry <= TRANSIENT_RETRY_LIMIT; retry += 1) {
      try {
        const outcome = await this.createAttempt(nickname, generation);
        if (this.stale(generation) || outcome === 'settled') {
          return;
        }
        // The MAX_CREATE_ATTEMPTS collision loop is exhausted. That is not a
        // transient transport failure, so the retry budget does not apply.
        this.fail('CONNECTION_FAILED');
        return;
      } catch (error) {
        if (this.stale(generation)) {
          return;
        }
        this.log('createRoom failed', error);
      }
      if (this.stale(generation)) {
        return;
      }
    }
    this.fail('CONNECTION_FAILED');
  }

  /**
   * One full create sequence: the MAX_CREATE_ATTEMPTS code-collision loop on
   * its own fresh transport. Resolves `'settled'` once this tab claimed the
   * room (or the attempt was superseded) and `'exhausted'` when every code
   * collided. A thrown transport/presence failure closes that attempt's channel
   * and propagates, so the caller can retry the whole sequence once.
   */
  private async createAttempt(
    nickname: string,
    generation: number,
  ): Promise<'settled' | 'exhausted'> {
    await this.syncClock();
    if (this.stale(generation)) {
      return 'settled';
    }
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const roomCode = randomRoomCode(this.uuid);
      const roomId = this.uuid();
      const transport = this.openTransport(roomCode);
      this.transport = transport;
      try {
        await transport.connect();
        if (this.stale(generation)) {
          await this.abandon(transport);
          return 'settled';
        }
        await transport.awaitPresence();
        if (this.stale(generation)) {
          await this.abandon(transport);
          return 'settled';
        }
        if (this.foreignRoomIds(transport, roomId).length > 0) {
          await this.abandon(transport);
          continue;
        }
        await transport.track(this.presencePayload(roomId));
        await transport.awaitPresence();
        if (this.stale(generation)) {
          await this.abandon(transport);
          return 'settled';
        }
        if (
          this.foreignRoomIds(transport, roomId).some(
            (foreign) => foreign < roomId,
          )
        ) {
          await this.abandon(transport);
          continue;
        }
        this.claim(roomId, roomCode, nickname);
        return 'settled';
      } catch (error) {
        await this.abandon(transport);
        throw error;
      }
    }
    return 'exhausted';
  }

  async joinRoom(code: string, nickname: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.configError !== null) {
      this.error = this.configError;
      this.status = 'error';
      this.markChanged();
      return;
    }
    if (!RoomCode.safeParse(code).success) {
      await this.closeTransport(this.teardownRoom());
      this.fail('INVALID_ROOM_CODE');
      return;
    }
    await this.closeTransport(this.teardownRoom());
    const generation = this.generation;
    this.roomCode = code;
    this.setStatus('connecting');
    // The only retryable join failures are an empty discovery and a thrown
    // transport/presence error; the last of those decides the terminal error.
    let failure: SessionError = 'CONNECTION_FAILED';
    for (let retry = 0; retry <= TRANSIENT_RETRY_LIMIT; retry += 1) {
      try {
        const outcome = await this.joinAttempt(code, nickname, generation);
        if (this.stale(generation)) {
          return;
        }
        if (outcome === 'settled') {
          return;
        }
        failure = 'ROOM_NOT_FOUND';
      } catch (error) {
        if (this.stale(generation)) {
          return;
        }
        this.log('joinRoom failed', error);
        failure = 'CONNECTION_FAILED';
      }
      if (this.stale(generation)) {
        return;
      }
    }
    this.fail(failure);
  }

  /**
   * One full join sequence on its own fresh transport. Resolves `'settled'`
   * when the attempt reached an outcome the caller must keep (connected, a
   * terminal error such as INVALID/ROOM_FULL, or a superseded generation) and
   * `'not-found'` for an empty discovery, the only retryable non-throw outcome.
   */
  private async joinAttempt(
    code: string,
    nickname: string,
    generation: number,
  ): Promise<'settled' | 'not-found'> {
    // A retry must not inherit a half-bound room from the failed attempt: only
    // an unbound session may run discovery on the replacement transport, and a
    // fresh channel must not carry half-assembled transfers from the dead one.
    if (this.state !== null || this.mode !== 'idle' || this.roomId !== null) {
      this.state = null;
      this.mode = 'idle';
      this.roomId = null;
      this.markChanged();
    }
    this.reassembler.reset();
    await this.syncClock();
    if (this.stale(generation)) {
      return 'settled';
    }
    const transport = this.openTransport(code);
    this.transport = transport;
    try {
      await transport.connect();
      if (this.stale(generation)) {
        await this.abandon(transport);
        return 'settled';
      }
      await transport.awaitPresence();
      if (this.stale(generation)) {
        await this.abandon(transport);
        return 'settled';
      }
      const discovered = await this.discover(transport);
      if (this.stale(generation)) {
        await this.abandon(transport);
        return 'settled';
      }
      if (discovered === null) {
        await this.abandon(transport);
        return 'not-found';
      }
      // An empty nickname is only valid for a rebinding/reconnecting retained
      // identity: the engine keeps the stored name, but the JOIN command must
      // still carry a schema-valid nickname. Fall back to the discovered name.
      const effectiveNickname = Nickname.safeParse(nickname).success
        ? nickname
        : discovered.players[this.clientId]?.nickname;
      if (effectiveNickname === undefined) {
        // A new identity must supply a nickname; never expose the foreign room.
        await this.abandon(transport);
        if (this.stale(generation)) {
          // A newer create/join owns this session now; its state must not be
          // overwritten with this attempt's terminal error.
          return 'settled';
        }
        this.fail('INVALID');
        return 'settled';
      }
      this.roomId = discovered.roomId;
      this.mode = 'client';
      this.state = discovered;
      await transport.track(this.presencePayload(discovered.roomId));
      await transport.awaitPresence();
      if (this.stale(generation)) {
        await this.abandon(transport);
        return 'settled';
      }
      this.markChanged();
      const result = await this.dispatch({
        type: 'JOIN',
        nickname: effectiveNickname,
      });
      if (this.stale(generation)) {
        return 'settled';
      }
      if (result.status === 'rejected') {
        this.fail(result.reason);
        return 'settled';
      }
      // The accepted result can arrive before the queued (chunked) snapshot, so
      // stay 'connecting' until the authoritative state shows our own binding.
      const converged = await this.waitForJoin(result.stateVersion);
      if (this.stale(generation)) {
        return 'settled';
      }
      if (converged) {
        this.setStatus('connected');
        this.markChanged();
      } else {
        this.requestResync();
      }
      return 'settled';
    } catch (error) {
      await this.abandon(transport);
      throw error;
    }
  }

  private stale(generation: number): boolean {
    return this.disposed || this.generation !== generation;
  }

  /**
   * Whether this tab holds an admitted, active, own-bound player record. A
   * stale/read-only tab or an unjoined identity just closes without dispatching
   * a LEAVE the host would reject.
   */
  private canLeaveAsAdmittedPlayer(): boolean {
    const state = this.state;
    if (state === null) {
      return false;
    }
    const me = state.players[this.clientId];
    return (
      me !== undefined &&
      me.connected &&
      me.status !== 'kicked' &&
      me.status !== 'left' &&
      me.connectionId === this.connectionId
    );
  }

  /** Whether the adopted state proves our own JOIN and connection binding. */
  private stateSatisfiesJoin(version: number): boolean {
    const state = this.state;
    return (
      state !== null &&
      state.stateVersion >= version &&
      state.players[this.clientId]?.connectionId === this.connectionId
    );
  }

  /**
   * Resolves once an authoritative snapshot at or beyond the accepted JOIN
   * version shows our own bound connection; otherwise times out bounded.
   */
  private waitForJoin(version: number): Promise<boolean> {
    if (this.stateSatisfiesJoin(version)) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.joinWaiter = null;
        resolve(false);
      }, this.commandTimeoutMs);
      this.joinWaiter = { version, resolve, timer };
    });
  }

  dispatch(action: ClientAction): Promise<CommandResult> {
    if (this.disposed || this.state === null || this.mode === 'idle') {
      return Promise.resolve({
        status: 'rejected',
        reason: 'CONNECTION_FAILED',
      });
    }
    if (
      this.rejoining ||
      this.transport === null ||
      !this.transport.isConnected()
    ) {
      return Promise.resolve({
        status: 'rejected',
        reason: 'CONNECTION_FAILED',
      });
    }
    if (this.mode === 'host') {
      return Promise.resolve(this.dispatchHost(action));
    }
    const state = this.state;
    const commandId = this.uuid();
    const body: WireBody = {
      type: 'COMMAND',
      commandId,
      gameNumber: state.gameNumber,
      roundNumber: state.round?.number ?? 0,
      command: action,
    };
    const event = this.envelope(body);
    return new Promise<CommandResult>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(commandId);
        this.markChanged();
        this.requestResync();
        resolve({ status: 'rejected', reason: 'COMMAND_TIMEOUT' });
      }, this.commandTimeoutMs);
      this.pending.set(commandId, { resolve, timer });
      this.markChanged();
      void this.transport?.send(event);
    });
  }

  async leave(): Promise<void> {
    const generation = this.generation;
    try {
      if (this.mode === 'host' && this.state !== null) {
        this.dispatchHost({ type: 'LEAVE' });
      } else if (this.mode === 'client' && this.canLeaveAsAdmittedPlayer()) {
        await this.dispatch({ type: 'LEAVE' });
      }
    } catch {
      // The LEAVE is best-effort; teardown must still run.
    }
    if (this.generation !== generation) {
      // A new create/join superseded this leave; it owns the fresh room.
      return;
    }
    await this.closeTransport(this.teardownRoom());
    this.markChanged();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.closeTransport(this.teardownRoom());
    this.listeners.clear();
  }

  /**
   * Atomically drops every resource of the current room: timers, pending
   * commands (resolved terminal), the sender queue and reassembly buffers, and
   * the room/state/status. Returns the captured transport so the caller can
   * close it without touching a fresh room created afterwards.
   */
  private teardownRoom(): RoomTransport | null {
    this.generation += 1;
    const transport = this.transport;
    this.transport = null;
    this.clearAllTimers();
    for (const pending of this.pending.values()) {
      this.clock.clearTimeout(pending.timer);
      pending.resolve({ status: 'rejected', reason: 'CONNECTION_FAILED' });
    }
    this.pending.clear();
    this.sender.reset();
    this.reassembler.reset();
    this.claiming = false;
    this.rejoining = false;
    this.rejoinHigherEpoch = false;
    // End any in-flight discovery terminally and clear its local timers, so a
    // stale timeout can never clear or hang a subsequent join.
    this.cancelDiscovery(null);
    this.claimSnapshots.clear();
    this.pendingClaim = null;
    this.pendingSnapshotVersion = null;
    // Room-scoped limiters reset here so a fresh room never inherits buckets
    // and cross-room key rotation cannot retain attacker keys. The presence
    // limiter is deliberately NOT reset: the server enforces a per-client
    // presence call quota and a rejoin must not refresh it.
    this.rateLimiter.reset();
    this.stateRequestLimiter.reset();
    this.stateRequestSenderLimiter.reset();
    if (this.joinWaiter !== null) {
      this.clock.clearTimeout(this.joinWaiter.timer);
      this.joinWaiter.resolve(false);
      this.joinWaiter = null;
    }
    this.lastAck = null;
    this.ackedVersion = -1;
    this.lastResyncAt = -1;
    this.migrationOldEpoch = 0;
    this.state = null;
    this.mode = 'idle';
    this.roomCode = null;
    this.roomId = null;
    this.error = null;
    this.status = 'idle';
    this.dirty = true;
    // Notify after clearing so consumers never keep rendering a stale room.
    this.markChanged();
    return transport;
  }

  // ---- transport lifecycle -------------------------------------------------

  private openTransport(roomCode: string): RoomTransport {
    const transport = this.factory.create(roomCode, {
      clientId: this.clientId,
      connectionId: this.connectionId,
    });
    const generation = this.generation;
    // Bind every callback to this exact transport and lifecycle generation: a
    // replaced, closed or abandoned old channel must never mutate the fresh
    // room (e.g. a late CLOSED or presence event after a room-code redraw).
    const live = (): boolean =>
      !this.disposed &&
      this.transport === transport &&
      this.generation === generation;
    transport.onEvent((payload) => {
      if (live()) {
        this.handleRaw(payload);
      }
    });
    transport.onReconnect(() => {
      if (live()) {
        this.handleReconnect();
      }
    });
    transport.onDisconnect(() => {
      if (live()) {
        this.handleDisconnect();
      }
    });
    transport.onPresence(() => {
      if (live()) {
        this.handlePresence();
      }
    });
    return transport;
  }

  /**
   * Detaches the transport synchronously, then closes it. Detaching first means
   * a close/`CLOSED` callback that fires while `disconnect()` is still pending
   * can no longer mutate the session: an automatic retry keeps reading
   * `connecting` and a newer create/join keeps owning the room. The identity
   * guard still leaves a replacement transport attached.
   */
  private async abandon(transport: RoomTransport): Promise<void> {
    if (this.transport === transport) {
      this.transport = null;
    }
    await transport.disconnect();
  }

  private async closeTransport(transport: RoomTransport | null): Promise<void> {
    if (transport === null) {
      return;
    }
    await transport.disconnect();
  }

  private claim(roomId: string, roomCode: string, nickname: string): void {
    const state = createInitialState({
      roomId,
      roomCode,
      host: {
        id: this.clientId,
        connectionId: this.connectionId,
        nickname,
      },
      genrePool: this.genreCatalogue,
      settings: this.settings,
      at: this.now(),
      rngSeed: randomSeed(this.uuid),
    });
    this.roomId = roomId;
    this.roomCode = roomCode;
    this.mode = 'host';
    this.state = state;
    this.setStatus('connected');
    this.markChanged();
    this.publishState();
    this.scheduleDeadline();
  }

  private discover(transport: RoomTransport): Promise<GameState | null> {
    return new Promise((resolve) => {
      const generation = this.generation;
      const candidates = new Map<string, GameState>();
      let settleTimer = 0;
      const finishDiscovery = (state: GameState | null) => {
        // Identity guard: a superseded discovery must never clear or resolve a
        // newer one (an old timeout firing after a second join would otherwise
        // clear the new resolver and hang that join forever).
        if (this.discoveryResolve !== resolve) {
          return;
        }
        this.cancelDiscovery(state);
      };
      const pickCanonical = () => {
        let bestId: string | null = null;
        let best: GameState | null = null;
        for (const [roomId, state] of candidates) {
          if (bestId === null || roomId < bestId) {
            bestId = roomId;
            best = state;
          }
        }
        finishDiscovery(best);
      };
      const resolver = (event: NetworkEvent) => {
        if (this.discoveryResolver !== resolver || this.stale(generation)) {
          return;
        }
        const body = event.body;
        if (
          body.type !== 'SNAPSHOT' ||
          body.recipientId !== null ||
          event.roomCode !== transport.roomCode ||
          event.roomId === null ||
          event.roomId !== body.state.roomId ||
          body.state.hostId !== event.senderId ||
          event.hostEpoch !== body.state.hostEpoch
        ) {
          return;
        }
        // The broadcaster must be a live presence tuple for this exact room.
        const present = transport.presencePayloads();
        const live = present.some(
          (payload) =>
            payload.clientId === event.senderId &&
            payload.connectionId === event.connectionId &&
            payload.roomId === event.roomId,
        );
        if (!live) {
          return;
        }
        const roomIds = new Set(present.map((payload) => payload.roomId));
        if (roomIds.size <= 1) {
          finishDiscovery(body.state);
          return;
        }
        // Code collision: pick the canonical (lex-smallest) room, not the
        // first packet to arrive.
        candidates.set(body.state.roomId, body.state);
        if (settleTimer === 0) {
          settleTimer = this.clock.setTimeout(
            pickCanonical,
            CANONICAL_SETTLE_MS,
          );
          this.discoveryTimers.push(settleTimer);
        }
      };
      this.discoveryResolver = resolver;
      this.discoveryResolve = resolve;
      this.discoveryTimers = [
        this.clock.setTimeout(pickCanonical, this.discoveryTimeoutMs),
      ];
      this.sendEvent(
        this.envelope(
          { type: 'STATE_REQUEST', knownVersion: null },
          { roomCode: transport.roomCode, roomId: null, hostEpoch: 0 },
        ),
      );
    });
  }

  /**
   * Terminal resolution of the in-flight discovery: clears its resolver and
   * every local timer and resolves the waiting promise exactly once (with
   * `null` on teardown). Identity-guarded so a superseded discovery can never
   * clear or resolve a newer one, and no local timer or hung promise leaks.
   */
  private cancelDiscovery(result: GameState | null): void {
    const resolve = this.discoveryResolve;
    this.discoveryResolver = null;
    this.discoveryResolve = null;
    for (const timer of this.discoveryTimers) {
      this.clock.clearTimeout(timer);
    }
    this.discoveryTimers = [];
    if (resolve !== null) {
      resolve(result);
    }
  }

  // ---- event routing -------------------------------------------------------

  private handleRaw(payload: unknown): void {
    const parsed = NetworkEventSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const event = parsed.data;
    if (event.body.type === 'SNAPSHOT_PART') {
      // Authorize before allocating any reassembly state.
      if (!this.partAuthorized(event)) {
        return;
      }
      this.reassembler.feed(event, {
        onComplete: (rebuilt) => this.routeEvent(rebuilt),
        onFailure: () => this.requestResync(),
      });
      return;
    }
    this.routeEvent(event);
  }

  private partAuthorized(event: NetworkEvent): boolean {
    if (this.roomCode !== null && event.roomCode !== this.roomCode) {
      return false;
    }
    if (this.roomId !== null && event.roomId !== this.roomId) {
      return false;
    }
    const state = this.state;
    if (state === null) {
      const present = this.transport?.presencePayloads();
      if (present === undefined || event.roomId === null) {
        return false;
      }
      let live = false;
      let canonicalRoomId: string | null = null;
      for (const payload of present) {
        if (canonicalRoomId === null || payload.roomId < canonicalRoomId) {
          canonicalRoomId = payload.roomId;
        }
        if (
          payload.clientId === event.senderId &&
          payload.connectionId === event.connectionId &&
          payload.roomId === event.roomId
        ) {
          live = true;
        }
      }
      return live && event.roomId === canonicalRoomId;
    }
    if (!this.liveBoundSender(event)) {
      return false;
    }
    if (
      event.hostEpoch === state.hostEpoch &&
      event.senderId === state.hostId
    ) {
      return true;
    }
    if (this.claiming && event.hostEpoch === this.migrationOldEpoch) {
      return true;
    }
    return this.acceptNewerEpoch(event);
  }

  private routeEvent(event: NetworkEvent): void {
    switch (event.body.type) {
      case 'SNAPSHOT':
        this.onSnapshot(event);
        return;
      case 'REPLICA_SNAPSHOT':
        this.onReplicaSnapshot(event);
        return;
      case 'COMMAND':
        this.onCommand(event);
        return;
      case 'COMMAND_RESULT':
        this.onCommandResult(event);
        return;
      case 'STATE_REQUEST':
        this.onStateRequest(event);
        return;
      case 'SNAPSHOT_ACK':
        this.onSnapshotAck(event);
        return;
      case 'HOST_CLAIM':
        this.onHostClaim(event);
        return;
      case 'HOST_HANDOFF':
        this.onHostHandoff(event);
        return;
      case 'SNAPSHOT_PART':
        return;
    }
  }

  private onSnapshot(event: NetworkEvent): void {
    if (this.mode === 'client') {
      this.acceptSnapshot(event);
      return;
    }
    if (this.mode === 'idle') {
      this.discoveryResolver?.(event);
      return;
    }
    this.onHostSnapshot(event);
  }

  /**
   * As host, only a strictly newer valid lineage supersedes this tab (a
   * migration this host missed). Never adopt a same-or-older lineage, so a
   * former host that reconnects cannot republish stale authority.
   */
  private onHostSnapshot(event: NetworkEvent): void {
    const body = event.body;
    const state = this.state;
    if (body.type !== 'SNAPSHOT' || state === null) {
      return;
    }
    const incoming = body.state;
    if (
      event.roomId !== state.roomId ||
      incoming.roomId !== state.roomId ||
      isSelfBoundHost(incoming, this.clientId, this.connectionId)
    ) {
      return;
    }
    // Only a strictly higher confirmed epoch supersedes this host; a higher
    // epoch dominates any version tie caused by local presence bumps.
    if (event.hostEpoch <= state.hostEpoch) {
      return;
    }
    if (!this.acceptNewerEpoch(event)) {
      return;
    }
    this.adopt(incoming, event);
  }

  private acceptSnapshot(event: NetworkEvent): boolean {
    const body = event.body;
    if (body.type !== 'SNAPSHOT') {
      return false;
    }
    const incoming = body.state;
    if (this.roomCode !== null && event.roomCode !== this.roomCode) {
      return false;
    }
    if (event.roomId === null || event.roomId !== incoming.roomId) {
      return false;
    }
    if (incoming.hostId !== event.senderId) {
      return false;
    }
    if (event.hostEpoch !== incoming.hostEpoch) {
      return false;
    }
    if (this.state === null) {
      if (this.roomCode !== null && incoming.roomCode !== this.roomCode) {
        return false;
      }
      this.adopt(incoming, event);
      return true;
    }
    if (incoming.roomId !== this.state.roomId) {
      return false;
    }
    const localEpoch = this.state.hostEpoch;
    if (event.hostEpoch < localEpoch) {
      return false;
    }
    if (event.hostEpoch === localEpoch) {
      // Same epoch: same host and strictly newer version only.
      if (
        incoming.hostId !== this.state.hostId ||
        incoming.stateVersion <= this.state.stateVersion
      ) {
        return false;
      }
    } else if (event.hostEpoch === localEpoch + 1) {
      if (!this.acceptNewerEpoch(event)) {
        // A one-step higher epoch dominates the version, but only from a
        // trusted lineage (bound, present, elected or a scoped claim).
        return false;
      }
    } else {
      // A live Presence tuple is not a migration lineage. Reject skipped
      // epochs rather than letting discovery rules preempt a confirmed host.
      // A recovering former host must not reclaim over a legitimate newer
      // candidate; an unresolved lineage requires fresh room discovery.
      const present = this.connectionIds(this.transport);
      const incumbent = this.state.players[this.state.hostId]?.connectionId;
      if (
        this.rejoining &&
        (incumbent === undefined || !present.includes(incumbent)) &&
        this.liveBoundSender(event) &&
        electHost(this.state, present) === event.senderId
      ) {
        this.rejoinHigherEpoch = true;
      }
      return false;
    }
    this.adopt(incoming, event);
    return true;
  }

  /** The event sender is a known player bound to that connection and present. */
  private liveBoundSender(event: NetworkEvent): boolean {
    const state = this.state;
    if (state === null) {
      return false;
    }
    const player = state.players[event.senderId];
    if (
      player === undefined ||
      player.connectionId !== event.connectionId ||
      player.status === 'kicked' ||
      player.status === 'left'
    ) {
      return false;
    }
    return this.connectionIds(this.transport).includes(event.connectionId);
  }

  /**
   * A higher epoch may supersede the local one even on a version tie, but only
   * by exactly one step, only from a bound, known, present, eligible sender,
   * and only while the incumbent host's own connection is absent. The sender
   * must be the deterministic election winner under the local presence, or the
   * candidate of a scoped, unexpired claim we observed. This stops a rejoining
   * older participant from preempting a younger confirmed host that is still
   * present, and stops arbitrary epoch escalation via a remembered sender id.
   */
  private acceptNewerEpoch(event: NetworkEvent): boolean {
    const state = this.state;
    if (state === null) {
      return false;
    }
    // Normal paths accept only a single, consecutive epoch step.
    if (event.hostEpoch !== state.hostEpoch + 1) {
      return false;
    }
    const present = this.connectionIds(this.transport);
    const incumbent = state.players[state.hostId]?.connectionId;
    if (incumbent !== undefined && present.includes(incumbent)) {
      return false;
    }
    if (!this.liveBoundSender(event)) {
      return false;
    }
    if (electHost(state, present) === event.senderId) {
      return true;
    }
    const claim = this.pendingClaim;
    return (
      claim !== null &&
      this.now() - claim.at <= MIGRATION_CLAIM_TTL_MS &&
      claim.oldEpoch === state.hostEpoch &&
      claim.newEpoch === event.hostEpoch &&
      claim.candidateId === event.senderId &&
      claim.connectionId === event.connectionId
    );
  }

  private adopt(state: GameState, event: NetworkEvent): void {
    const wasRejoining = this.rejoining;
    this.state = state;
    this.roomId = state.roomId;
    this.roomCode = state.roomCode;
    // Any adoption ends the old-epoch claim window and the rejoin-escalation
    // guard: authority now follows the adopted lineage.
    this.pendingClaim = null;
    this.rejoinHigherEpoch = false;
    this.clearResync();
    this.clearMigrationAbort();
    this.clearReclaim();
    if (
      this.status === 'migrating' ||
      this.status === 'reconnecting' ||
      this.status === 'connecting'
    ) {
      this.setStatus('connected');
    }
    const body = event.body;
    const selfBound = isSelfBoundHost(state, this.clientId, this.connectionId);
    let yielded = false;
    if (this.mode === 'client' && selfBound) {
      this.promote();
    } else if (this.mode === 'host' && !selfBound) {
      // A newer lineage superseded this host tab; become a read-only client.
      this.mode = 'client';
      this.clearDeadline();
      this.setStatus('connected');
      yielded = true;
    }
    this.rejoining = false;
    if ((wasRejoining || yielded) && !selfBound) {
      // Yielded to a newer lineage (a rejoining host or a reclaimed host that
      // is now a player): make sure our own presence reflects the client role.
      this.retrack();
    }
    if (
      this.joinWaiter !== null &&
      this.stateSatisfiesJoin(this.joinWaiter.version)
    ) {
      const waiter = this.joinWaiter;
      this.joinWaiter = null;
      this.clock.clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    if (
      body.type === 'SNAPSHOT' &&
      body.ackClientId === this.clientId &&
      this.ackedVersion !== state.stateVersion
    ) {
      this.ackedVersion = state.stateVersion;
      this.sendEvent(
        this.envelope(
          { type: 'SNAPSHOT_ACK', stateVersion: state.stateVersion },
          { hostEpoch: state.hostEpoch },
        ),
      );
    }
    // Resolve commands the host already applied, even if their explicit
    // COMMAND_RESULT was lost or arrived from a now-stale connection, and any
    // staged accepted command whose version the snapshot has now reached.
    for (const [commandId, pending] of [...this.pending]) {
      const converged =
        pending.version !== undefined && state.stateVersion >= pending.version;
      if (converged || state.appliedCommandIds.includes(commandId)) {
        this.pending.delete(commandId);
        this.clock.clearTimeout(pending.timer);
        pending.resolve({
          status: 'accepted',
          stateVersion: state.stateVersion,
        });
      }
    }
    this.markChanged();
  }

  private onHostHandoff(event: NetworkEvent): void {
    const body = event.body;
    if (body.type !== 'HOST_HANDOFF') {
      return;
    }
    const state = this.state;
    if (state === null || this.mode === 'host') {
      return;
    }
    if (
      event.roomId === null ||
      event.roomId !== state.roomId ||
      event.roomCode !== state.roomCode ||
      event.hostEpoch !== state.hostEpoch
    ) {
      return;
    }
    // Only the currently confirmed host connection may rebind itself.
    if (
      event.senderId !== state.hostId ||
      event.connectionId !== state.players[state.hostId]?.connectionId
    ) {
      return;
    }
    const incoming = body.state;
    if (
      incoming.roomId !== state.roomId ||
      incoming.roomCode !== state.roomCode ||
      incoming.hostEpoch !== state.hostEpoch ||
      incoming.hostId !== event.senderId ||
      incoming.stateVersion <= state.stateVersion ||
      incoming.stateVersion !== body.baseVersion + 1 ||
      body.recipientId !== event.senderId
    ) {
      return;
    }
    const binding = incoming.players[incoming.hostId]?.connectionId;
    if (binding === undefined || binding === event.connectionId) {
      return;
    }
    this.adopt(incoming, event);
  }

  private onReplicaSnapshot(event: NetworkEvent): void {
    const body = event.body;
    const state = this.state;
    if (body.type !== 'REPLICA_SNAPSHOT' || !this.claiming || state === null) {
      return;
    }
    if (body.recipientId !== this.clientId) {
      return;
    }
    if (event.roomId === null || event.roomId !== this.roomId) {
      return;
    }
    // The offer must come from a live, bound, eligible participant.
    if (!this.liveBoundSender(event)) {
      return;
    }
    const incoming = body.state;
    if (
      incoming.roomId !== this.roomId ||
      incoming.roomCode !== state.roomCode ||
      incoming.hostEpoch !== this.migrationOldEpoch ||
      incoming.hostId !== state.hostId ||
      incoming.stateVersion <= 0
    ) {
      return;
    }
    // At most one offer per sender, bounded by the participant set.
    if (!this.claimSnapshots.has(event.senderId)) {
      this.claimSnapshots.set(event.senderId, incoming);
    }
  }

  private onCommandResult(event: NetworkEvent): void {
    const body = event.body;
    if (body.type !== 'COMMAND_RESULT') {
      return;
    }
    if (this.mode !== 'client' || this.state === null) {
      return;
    }
    if (body.recipientId !== this.clientId) {
      return;
    }
    if (event.roomId !== this.state.roomId) {
      return;
    }
    const host = this.state.players[this.state.hostId];
    if (
      event.senderId !== this.state.hostId ||
      host?.connectionId !== event.connectionId ||
      event.hostEpoch !== this.state.hostEpoch
    ) {
      return;
    }
    const pending = this.pending.get(body.commandId);
    if (pending === undefined) {
      return;
    }
    if (body.result.status === 'accepted') {
      // Accepted-state convergence: resolve only once the authoritative state
      // reaches the accepted version, so consumers never see stale state.
      if (this.state.stateVersion >= body.result.stateVersion) {
        this.pending.delete(body.commandId);
        this.clock.clearTimeout(pending.timer);
        pending.resolve(body.result);
      } else {
        this.pending.set(body.commandId, {
          ...pending,
          version: body.result.stateVersion,
        });
      }
      this.markChanged();
      return;
    }
    this.pending.delete(body.commandId);
    this.clock.clearTimeout(pending.timer);
    pending.resolve(body.result);
    this.markChanged();
  }

  private onStateRequest(event: NetworkEvent): void {
    const body = event.body;
    const state = this.state;
    if (
      body.type !== 'STATE_REQUEST' ||
      this.mode !== 'host' ||
      state === null
    ) {
      return;
    }
    if (
      event.roomCode !== this.roomCode ||
      event.connectionId === this.connectionId
    ) {
      return;
    }
    // A requester that already holds this version needs nothing, unless it is
    // on an older epoch (a version tie with the newer lineage) and must learn it.
    if (
      event.hostEpoch >= state.hostEpoch &&
      body.knownVersion !== null &&
      body.knownVersion >= state.stateVersion
    ) {
      return;
    }
    // Coalesce by logical version: a room-broadcast snapshot for this exact
    // version is already queued/in flight and satisfies every requester. A
    // duplicate would only grow the FIFO and starve the current state.
    if (this.pendingSnapshotVersion === state.stateVersion) {
      return;
    }
    const now = this.now();
    // Global room bound plus a per-sender bound: unsigned sender ids can be
    // rotated, so the global budget is what actually caps amplification.
    if (
      !this.stateRequestLimiter.allow('room', now) ||
      !this.stateRequestSenderLimiter.allow(event.senderId, now)
    ) {
      return;
    }
    this.publishState();
  }

  private onSnapshotAck(event: NetworkEvent): void {
    const body = event.body;
    const state = this.state;
    if (
      body.type !== 'SNAPSHOT_ACK' ||
      this.mode !== 'host' ||
      state === null
    ) {
      return;
    }
    if (
      event.roomId !== state.roomId ||
      body.stateVersion !== state.stateVersion
    ) {
      return;
    }
    // Bound to the single designated replica and its current binding, so the
    // bookkeeping cannot grow from forged sender ids.
    const designated = designatedReplicaId(state);
    if (designated === null || event.senderId !== designated) {
      return;
    }
    if (state.players[designated]?.connectionId !== event.connectionId) {
      return;
    }
    if (!this.connectionIds(this.transport).includes(event.connectionId)) {
      return;
    }
    this.lastAck = { clientId: designated, stateVersion: body.stateVersion };
  }

  // ---- host authority ------------------------------------------------------

  private onCommand(event: NetworkEvent): void {
    const body = event.body;
    if (body.type !== 'COMMAND') {
      return;
    }
    const state = this.state;
    if (this.mode !== 'host' || state === null) {
      return;
    }
    if (
      event.roomId === null ||
      event.roomId !== state.roomId ||
      event.roomCode !== state.roomCode ||
      event.hostEpoch !== state.hostEpoch ||
      event.connectionId === this.connectionId
    ) {
      return;
    }
    // Validate the known-command binding BEFORE consuming or creating a limiter
    // bucket, so unsigned rotating sender ids cannot grow the limiter map. A
    // legitimate pre-tracked JOIN from an unknown identity is the only
    // exception: the JOIN is what creates the identity in the first place.
    const actor = state.players[event.senderId];
    if (body.command.type !== 'JOIN') {
      if (actor === undefined) {
        this.sendCommandResult(event.senderId, body.commandId, {
          status: 'rejected',
          reason: 'FORBIDDEN',
        });
        return;
      }
      if (actor.connectionId !== event.connectionId) {
        this.sendCommandResult(event.senderId, body.commandId, {
          status: 'rejected',
          reason: 'STALE',
        });
        return;
      }
    }
    if (!this.rateLimiter.allow(event.senderId, this.now())) {
      this.sendCommandResult(event.senderId, body.commandId, {
        status: 'rejected',
        reason: 'RATE_LIMITED',
      });
      return;
    }
    const at = this.now();
    const afterDeadline = reducer(state, { type: 'DEADLINE', at });
    if (afterDeadline !== state) {
      this.setState(afterDeadline);
      this.publishState();
      this.scheduleDeadline();
    }
    const current = this.state;
    if (current === null) {
      return;
    }
    const action = {
      type: 'COMMAND' as const,
      actorId: event.senderId,
      connectionId: event.connectionId,
      commandId: body.commandId,
      at,
      gameNumber: body.gameNumber,
      roundNumber: body.roundNumber,
      command: body.command,
    };
    if (current.appliedCommandIds.includes(body.commandId)) {
      this.sendCommandResult(event.senderId, body.commandId, {
        status: 'accepted',
        stateVersion: current.stateVersion,
      });
      return;
    }
    const reason = classifyCommand(current, action);
    if (reason !== null) {
      this.sendCommandResult(event.senderId, body.commandId, {
        status: 'rejected',
        reason,
      });
      return;
    }
    const next = reducer(current, action);
    if (next === current) {
      this.sendCommandResult(event.senderId, body.commandId, {
        status: 'accepted',
        stateVersion: current.stateVersion,
      });
      return;
    }
    this.setState(next);
    this.sendCommandResult(event.senderId, body.commandId, {
      status: 'accepted',
      stateVersion: next.stateVersion,
    });
    this.publishState();
    this.scheduleDeadline();
  }

  private dispatchHost(action: ClientAction): CommandResult {
    const state = this.state;
    if (state === null) {
      return { status: 'rejected', reason: 'CONNECTION_FAILED' };
    }
    // A disconnected host must not keep mutating local state.
    if (this.transport === null || !this.transport.isConnected()) {
      return { status: 'rejected', reason: 'CONNECTION_FAILED' };
    }
    const at = this.now();
    const afterDeadline = reducer(state, { type: 'DEADLINE', at });
    if (afterDeadline !== state) {
      this.setState(afterDeadline);
      this.publishState();
      this.scheduleDeadline();
    }
    const current = this.state;
    if (current === null) {
      return { status: 'rejected', reason: 'CONNECTION_FAILED' };
    }
    const engineAction = {
      type: 'COMMAND' as const,
      actorId: this.clientId,
      connectionId: this.connectionId,
      commandId: this.uuid(),
      at,
      gameNumber: current.gameNumber,
      roundNumber: current.round?.number ?? 0,
      command: action,
    };
    const reason = classifyCommand(current, engineAction);
    if (reason !== null) {
      return { status: 'rejected', reason };
    }
    const next = reducer(current, engineAction);
    if (next === current) {
      return { status: 'accepted', stateVersion: current.stateVersion };
    }
    this.setState(next);
    this.publishState();
    this.scheduleDeadline();
    return { status: 'accepted', stateVersion: next.stateVersion };
  }

  private sendCommandResult(
    recipientId: string,
    commandId: string,
    result: WireCommandResult,
  ): void {
    this.sendEvent(
      this.envelope({ type: 'COMMAND_RESULT', recipientId, commandId, result }),
    );
  }

  private publishState(): void {
    const state = this.state;
    if (state === null || this.mode !== 'host') {
      return;
    }
    if (
      this.lastAck !== null &&
      this.lastAck.stateVersion !== state.stateVersion
    ) {
      // The recorded replica ACK belongs to an older version now.
      this.lastAck = null;
    }
    // Mark this logical version as queued/in flight until the whole batch
    // drains, so duplicate STATE_REQUESTs for it coalesce into one broadcast.
    this.pendingSnapshotVersion = state.stateVersion;
    this.sendEvent(
      this.envelope(
        {
          type: 'SNAPSHOT',
          recipientId: null,
          ackClientId: designatedReplicaId(state),
          state,
        },
        { hostEpoch: state.hostEpoch },
      ),
    );
  }

  private sendEvent(event: NetworkEvent): void {
    if (this.transport === null) {
      return;
    }
    let frames: NetworkEvent[];
    try {
      // The codec contract is fixed at 128 parts / 6 MiB. The reassembly TTL
      // resets on each new part, so fanout pacing with sub-5 s gaps completes
      // any transfer regardless of total duration.
      frames = encodeEvent(event, this.chunkLimits, this.uuid());
    } catch (error) {
      if (error instanceof ChunkError) {
        this.noteSendFailure();
        return;
      }
      throw error;
    }
    this.sender.submit(frames);
  }

  private noteSendFailure(): void {
    if (this.disposed || this.mode === 'idle') {
      return;
    }
    this.setStatus('reconnecting');
    // While the channel is down, wait for the rejoin callback instead of
    // re-arming a retry every second.
    if (this.transport === null || !this.transport.isConnected()) {
      return;
    }
    if (this.republishTimer === 0) {
      this.republishTimer = this.clock.setTimeout(() => {
        this.republishTimer = 0;
        this.resync();
      }, SEND_RETRY_MS);
    }
  }

  private resync(): void {
    if (this.disposed) {
      return;
    }
    if (this.mode === 'host') {
      this.retrack();
      this.publishState();
      this.scheduleDeadline();
      this.setStatus('connected');
    } else if (this.mode === 'client') {
      this.requestResync();
    }
  }

  private requestResync(): void {
    if (this.disposed || this.mode === 'idle') {
      return;
    }
    const generation = this.generation;
    // Restore our own presence independently of request coalescing: a reconnect
    // must always re-track, even if a request went out moments ago, or the host
    // election and PRESENCE_SYNC would exclude this tab and it would go ghost.
    this.retrack();
    // Rejected/expired attacker frames must not amplify into a request flood.
    const now = this.now();
    if (
      this.lastResyncAt >= 0 &&
      now - this.lastResyncAt < RESYNC_THROTTLE_MS
    ) {
      return;
    }
    this.lastResyncAt = now;
    this.setStatus('reconnecting');
    if (this.state !== null) {
      this.sendEvent(
        this.envelope(
          { type: 'STATE_REQUEST', knownVersion: this.state.stateVersion },
          { hostEpoch: this.state.hostEpoch },
        ),
      );
    }
    if (!this.rejoining && this.resyncTimer === 0) {
      this.resyncTimer = this.clock.setTimeout(() => {
        this.resyncTimer = 0;
        if (this.stale(generation)) {
          return;
        }
        if (this.status === 'reconnecting' || this.status === 'migrating') {
          this.setStatus('lost');
          this.setError('STATE_LOST');
        }
      }, this.resyncTimeoutMs);
    }
  }

  private retrack(): void {
    const transport = this.transport;
    if (transport === null || this.roomId === null || this.rejoining) {
      return;
    }
    // Presence storms close the channel, so cap reconnect re-tracks.
    if (!this.presenceLimiter.allow('self', this.now())) {
      return;
    }
    void transport.track(this.presencePayload(this.roomId));
  }

  // ---- deadlines -----------------------------------------------------------

  private scheduleDeadline(): void {
    this.clearDeadline();
    const state = this.state;
    if (state === null || this.mode !== 'host' || state.pause !== null) {
      return;
    }
    if (!('deadlineAt' in state.phase)) {
      return;
    }
    const delay = Math.max(1, state.phase.deadlineAt - this.now());
    this.deadlineTimer = this.clock.setTimeout(() => {
      this.deadlineTimer = 0;
      this.fireDeadline();
    }, delay);
  }

  private fireDeadline(): void {
    const state = this.state;
    if (state === null || this.mode !== 'host') {
      return;
    }
    const at =
      'deadlineAt' in state.phase ? state.phase.deadlineAt : this.now();
    const next = reducer(state, { type: 'DEADLINE', at });
    if (next === state) {
      this.scheduleDeadline();
      return;
    }
    this.setState(next);
    this.publishState();
    this.scheduleDeadline();
  }

  // ---- presence and migration ---------------------------------------------

  private handlePresence(): void {
    if (this.disposed) {
      return;
    }
    if (this.mode === 'host') {
      this.hostSyncPresence();
      return;
    }
    if (this.mode === 'client') {
      this.maybeMigrate();
    }
  }

  private handleDisconnect(): void {
    if (this.disposed || this.mode === 'idle') {
      return;
    }
    this.setStatus('reconnecting');
    this.reassembler.reset();
  }

  private handleReconnect(): void {
    void this.reconnectAndResync();
  }

  private async reconnectAndResync(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = this.generation;
    this.setStatus('reconnecting');
    // Wait for a fresh full presence sync before trusting any state.
    try {
      await this.transport?.awaitPresence();
    } catch {
      // A bounded failure is surfaced through the resync timeout instead.
    }
    if (this.stale(generation)) {
      return;
    }
    // A stale resync timeout must not kill a healthy rejoin.
    this.clearResync();
    // Hosts must not re-track before yielding: their own presence would win the
    // local election and mask the new lineage. Clients re-track via resync.
    if (this.mode === 'host') {
      this.beginHostRejoin();
    } else if (this.mode === 'client') {
      this.requestResync();
    }
  }

  /**
   * A host that dropped must stop acting as host. It asks the room for the
   * current authoritative state; if a newer lineage answers it yields, and it
   * only reclaims if nobody superseded it within the window.
   */
  private beginHostRejoin(): void {
    const state = this.state;
    const transport = this.transport;
    if (state === null || transport === null) {
      return;
    }
    this.rejoining = true;
    this.mode = 'client';
    this.rejoinHigherEpoch = false;
    this.clearDeadline();
    // Do NOT re-track while unsynced: keeping our own presence out of the
    // election input lets the deterministic winner answer us.
    this.sendEvent(
      this.envelope(
        { type: 'STATE_REQUEST', knownVersion: state.stateVersion },
        { hostEpoch: state.hostEpoch },
      ),
    );
    this.clearReclaim();
    this.reclaimTimer = this.clock.setTimeout(() => {
      this.reclaimTimer = 0;
      this.reclaimHost();
    }, this.resyncTimeoutMs);
  }

  private reclaimHost(): void {
    const state = this.state;
    const transport = this.transport;
    if (
      this.disposed ||
      state === null ||
      transport === null ||
      this.mode === 'host'
    ) {
      return;
    }
    if (!isSelfBoundHost(state, this.clientId, this.connectionId)) {
      return;
    }
    if (this.rejoinHigherEpoch) {
      // A newer epoch exists that we could not safely adopt (its sender was not
      // a live presence member). Never fabricate stale authority: surface the
      // loss instead of a split-brain republish of the old lineage.
      this.rejoining = false;
      this.loseState();
      return;
    }
    this.rejoining = false;
    this.mode = 'host';
    this.publishState();
    this.scheduleDeadline();
    void this.reclaimSync();
  }

  /**
   * A host that reclaims after a rejoin must put its own presence back before
   * it applies PRESENCE_SYNC or claims `connected`: otherwise the presence set
   * excludes the host, the engine marks it disconnected and host-only commands
   * are refused. Await a successful fresh track; a refused or errored track
   * leaves the status untouched rather than faking a connected host.
   */
  private async reclaimSync(): Promise<void> {
    const generation = this.generation;
    const transport = this.transport;
    const roomId = this.roomId;
    if (transport === null || roomId === null || this.mode !== 'host') {
      return;
    }
    // Presence storms close the channel, so cap reconnect re-tracks.
    if (!this.presenceLimiter.allow('self', this.now())) {
      return;
    }
    let status: SendStatus;
    try {
      status = await transport.track(this.presencePayload(roomId));
    } catch {
      return;
    }
    if (status !== 'ok' || this.stale(generation) || this.mode !== 'host') {
      return;
    }
    await transport.awaitPresence();
    if (this.stale(generation) || this.mode !== 'host') {
      return;
    }
    this.hostSyncPresence();
    this.setStatus('connected');
    this.markChanged();
  }

  private clearReclaim(): void {
    if (this.reclaimTimer !== 0) {
      this.clock.clearTimeout(this.reclaimTimer);
      this.reclaimTimer = 0;
    }
  }

  private hostSyncPresence(): void {
    const state = this.state;
    const transport = this.transport;
    if (state === null || transport === null) {
      return;
    }
    const connectionIds = this.connectionIds(transport);
    if (connectionIds.length === 0) {
      return;
    }
    const next = reducer(state, {
      type: 'PRESENCE_SYNC',
      at: this.now(),
      connectionIds,
    });
    if (next === state) {
      return;
    }
    this.setState(next);
    this.publishState();
    this.scheduleDeadline();
  }

  /**
   * Whether this exact tab is the election winner: the elected candidate is our
   * clientId AND the state binds that identity to THIS tab's connection, and
   * that connection is present. A read-only tab that shares its clientId with a
   * newer bound tab must never claim host authority.
   */
  private isOwnBoundCandidate(state: GameState, present: string[]): boolean {
    return (
      electHost(state, present) === this.clientId &&
      state.players[this.clientId]?.connectionId === this.connectionId &&
      present.includes(this.connectionId)
    );
  }

  private maybeMigrate(): void {
    const state = this.state;
    const transport = this.transport;
    if (state === null || transport === null) {
      return;
    }
    if (this.claiming || this.rejoining || this.status === 'migrating') {
      return;
    }
    const present = this.connectionIds(transport);
    const hostConnection = state.players[state.hostId]?.connectionId;
    if (hostConnection !== undefined && present.includes(hostConnection)) {
      return;
    }
    const candidate = electHost(state, present);
    if (candidate === null) {
      return;
    }
    // Only the tab the state actually binds may claim; a same-clientId tab with
    // a stale binding just waits for the bound tab's authority (or a snapshot).
    if (
      candidate === this.clientId &&
      this.isOwnBoundCandidate(state, present)
    ) {
      this.startClaim(present);
      return;
    }
    this.setStatus('migrating');
    this.armMigrationAbort();
  }

  private startClaim(present: string[]): void {
    const state = this.state;
    if (state === null || !this.isOwnBoundCandidate(state, present)) {
      this.setStatus('migrating');
      return;
    }
    this.claiming = true;
    this.setStatus('migrating');
    this.migrationOldEpoch = state.hostEpoch;
    this.claimSnapshots = new Map([[this.clientId, state]]);
    this.sendEvent(
      this.envelope(
        {
          type: 'HOST_CLAIM',
          baseVersion: state.stateVersion,
          candidateId: this.clientId,
        },
        { hostEpoch: state.hostEpoch + 1 },
      ),
    );
    this.migrationTimer = this.clock.setTimeout(() => {
      this.migrationTimer = 0;
      this.finishClaim();
    }, this.migrationCollectMs);
  }

  private finishClaim(): void {
    let base: GameState | null = null;
    for (const snapshot of this.claimSnapshots.values()) {
      if (base === null || snapshot.stateVersion > base.stateVersion) {
        base = snapshot;
      }
    }
    this.claiming = false;
    this.claimSnapshots = new Map();
    const transport = this.transport;
    if (base === null || transport === null) {
      this.loseState();
      return;
    }
    const present = this.connectionIds(transport);
    // Re-check the own bound binding against the adopted highest base: a tab
    // that lost its binding (a newer same-clientId tab) must never run a private
    // HOST_CHANGED mutation; it resyncs instead.
    if (!this.isOwnBoundCandidate(base, present)) {
      this.requestResync();
      return;
    }
    const hostEpoch = this.migrationOldEpoch + 1;
    const changed = reducer(base, {
      type: 'HOST_CHANGED',
      at: this.now(),
      hostId: this.clientId,
      hostEpoch,
      hostBaseVersion: base.stateVersion,
      connectionIds: present,
    });
    if (changed === base) {
      this.requestResync();
      return;
    }
    const synced = reducer(changed, {
      type: 'PRESENCE_SYNC',
      at: this.now(),
      connectionIds: present,
    });
    this.mode = 'host';
    this.state = synced;
    this.setStatus('connected');
    this.publishState();
    this.scheduleDeadline();
    this.markChanged();
  }

  private onHostClaim(event: NetworkEvent): void {
    const body = event.body;
    if (body.type !== 'HOST_CLAIM') {
      return;
    }
    const state = this.state;
    const transport = this.transport;
    if (this.mode !== 'client' || state === null || transport === null) {
      return;
    }
    if (event.roomId === null || event.roomId !== state.roomId) {
      return;
    }
    if (
      body.candidateId !== event.senderId ||
      event.hostEpoch !== state.hostEpoch + 1
    ) {
      return;
    }
    const present = this.connectionIds(transport);
    // No migration churn while the confirmed host connection is still present.
    const hostConnection = state.players[state.hostId]?.connectionId;
    if (hostConnection !== undefined && present.includes(hostConnection)) {
      return;
    }
    // The claimer must be the candidate's own bound, present connection.
    if (
      state.players[body.candidateId]?.connectionId !== event.connectionId ||
      electHost(state, present) !== body.candidateId
    ) {
      return;
    }
    if (
      body.candidateId === this.clientId &&
      event.connectionId === this.connectionId
    ) {
      // Our own bound tab is the candidate; it drives its own claim.
      return;
    }
    this.pendingClaim = {
      oldEpoch: state.hostEpoch,
      newEpoch: event.hostEpoch,
      candidateId: body.candidateId,
      connectionId: event.connectionId,
      baseVersion: body.baseVersion,
      at: this.now(),
    };
    this.setStatus('migrating');
    this.armMigrationAbort();
    // A stale read-only tab (same clientId, older bound connection) must not
    // donate a wrong-role replica; only a currently bound tab offers state.
    const own = state.players[this.clientId];
    if (own !== undefined && own.connectionId !== this.connectionId) {
      return;
    }
    this.sendEvent(
      this.envelope(
        {
          type: 'REPLICA_SNAPSHOT',
          recipientId: body.candidateId,
          state,
        },
        { hostEpoch: state.hostEpoch },
      ),
    );
  }

  private loseState(): void {
    this.setStatus('lost');
    this.setError('STATE_LOST');
  }

  // ---- helpers -------------------------------------------------------------

  private async syncClock(): Promise<void> {
    const ok = await this.clockSync.sync();
    if (!ok) {
      this.setError('CLOCK_SYNC_FAILED');
    }
    this.markChanged();
  }

  private envelope(
    body: WireBody,
    overrides: EnvelopeOverrides = {},
  ): NetworkEvent {
    return {
      protocolVersion: 1,
      roomCode: overrides.roomCode ?? this.roomCode ?? '',
      roomId: overrides.roomId !== undefined ? overrides.roomId : this.roomId,
      senderId: this.clientId,
      connectionId: this.connectionId,
      hostEpoch: overrides.hostEpoch ?? this.state?.hostEpoch ?? 0,
      sentAt: overrides.sentAt ?? this.now(),
      body,
    };
  }

  private presencePayload(roomId: string): Presence {
    return {
      protocolVersion: 1,
      clientId: this.clientId,
      connectionId: this.connectionId,
      roomId,
    };
  }

  /**
   * Fanout-aware ceiling for this room's outgoing frames. The denominator
   * counts the outgoing frame plus its recipients (`present` connections), so
   * it never understates the room's share of the budget. Other rooms, commands,
   * results and ACKs consume the same shared budget; this is a per-room burst
   * bound, not a whole-project guarantee.
   */
  private framesPerSecond(): number {
    const transport = this.transport;
    const present =
      transport === null ? 0 : transport.presencePayloads().length;
    return MESSAGE_BUDGET_PER_SECOND / Math.max(1, present);
  }

  private connectionIds(transport: RoomTransport | null): string[] {
    if (transport === null) {
      return [];
    }
    const roomId = this.roomId;
    const ids = new Set<string>();
    for (const payload of transport.presencePayloads()) {
      if (roomId !== null && payload.roomId !== roomId) {
        continue;
      }
      ids.add(payload.connectionId);
    }
    return [...ids];
  }

  private foreignRoomIds(
    transport: RoomTransport,
    ownRoomId: string,
  ): string[] {
    const ids: string[] = [];
    for (const presence of transport.presencePayloads()) {
      if (presence.connectionId === this.connectionId) {
        continue;
      }
      if (presence.roomId === ownRoomId) {
        continue;
      }
      ids.push(presence.roomId);
    }
    return ids;
  }

  private setState(state: GameState): void {
    const previous = this.state;
    this.state = state;
    if (
      this.mode === 'host' &&
      state.players[state.hostId]?.connectionId !== this.connectionId
    ) {
      // A rebinding JOIN moved host authority to another connection. Hand the
      // full state to the newly bound tab (same clientId) before this tab
      // becomes read-only; it can no longer produce schema-valid snapshots.
      const baseVersion = previous?.stateVersion ?? state.stateVersion - 1;
      this.sendEvent(
        this.envelope(
          {
            type: 'HOST_HANDOFF',
            recipientId: this.clientId,
            baseVersion,
            state,
          },
          { hostEpoch: state.hostEpoch },
        ),
      );
      this.mode = 'client';
      this.clearDeadline();
      this.setStatus('connected');
    }
    this.markChanged();
  }

  private promote(): void {
    this.mode = 'host';
    this.setStatus('connected');
    this.publishState();
    this.scheduleDeadline();
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.markChanged();
  }

  private setError(error: SessionError): void {
    this.error = error;
    this.markChanged();
  }

  private fail(code: SessionError): void {
    this.status = 'error';
    this.error = code;
    this.markChanged();
  }

  private markChanged(): void {
    this.dirty = true;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private armMigrationAbort(): void {
    this.clearMigrationAbort();
    this.migrationAbortTimer = this.clock.setTimeout(() => {
      this.migrationAbortTimer = 0;
      // The migration window closed: a claim observed inside it expires.
      this.pendingClaim = null;
      if (!this.claiming && this.status === 'migrating') {
        this.setStatus('connected');
      }
    }, this.migrationCollectMs * 4);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== 0) {
      this.clock.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = 0;
    }
  }

  private clearResync(): void {
    if (this.resyncTimer !== 0) {
      this.clock.clearTimeout(this.resyncTimer);
      this.resyncTimer = 0;
    }
  }

  private clearMigrationAbort(): void {
    if (this.migrationAbortTimer !== 0) {
      this.clock.clearTimeout(this.migrationAbortTimer);
      this.migrationAbortTimer = 0;
    }
  }

  private clearAllTimers(): void {
    this.clearDeadline();
    this.clearResync();
    this.clearMigrationAbort();
    if (this.migrationTimer !== 0) {
      this.clock.clearTimeout(this.migrationTimer);
      this.migrationTimer = 0;
    }
    if (this.republishTimer !== 0) {
      this.clock.clearTimeout(this.republishTimer);
      this.republishTimer = 0;
    }
    if (this.reclaimTimer !== 0) {
      this.clock.clearTimeout(this.reclaimTimer);
      this.reclaimTimer = 0;
    }
  }
}

export function createGameSession(options: GameSessionOptions): GameSession {
  return new NetworkGameSession(options);
}
