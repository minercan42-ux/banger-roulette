import { describe, expect, it } from 'vitest';
import { createInitialState } from '../engine';
import { NetworkEventSchema, type NetworkEvent } from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { InMemoryHub } from './inMemory';
import { RateLimiter } from './rateLimit';
import type { GameSession } from './session';
import {
  ManualClock,
  createTestSession,
  settle,
  testCatalogue,
  uuidFactory,
  type TestSessionConfig,
} from './testkit';

const CLOCK_START = 1_000;

function uid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function makeSession(
  hub: InMemoryHub,
  clock: ManualClock,
  uuid: () => string,
  n: number,
  extra: Partial<TestSessionConfig> = {},
): GameSession {
  return createTestSession({
    hub,
    clock,
    uuid,
    clientId: uid(100 + n),
    connectionId: uid(200 + n),
    ...extra,
  });
}

describe('net security boundaries', () => {
  it('leave fully tears down so a new room starts clean', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const session = makeSession(hub, clock, uuid, 0);
    await session.createRoom('Host');
    await settle(clock);
    expect(session.getSnapshot().status).toBe('connected');

    await session.leave();
    const afterLeave = session.getSnapshot();
    expect(afterLeave.status).toBe('idle');
    expect(afterLeave.state).toBeNull();
    expect(afterLeave.roomCode).toBeNull();
    expect(afterLeave.pendingCommands).toBe(0);

    await session.createRoom('Host2');
    await settle(clock);
    expect(session.getSnapshot().status).toBe('connected');
    expect(session.getSnapshot().error).toBeNull();
  });

  it('bounds the discovery-reply rate under a request flood', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;

    const sender = { clientId: uid(500), connectionId: uid(600) };
    const transport = hub.create(code, sender);
    const replies: NetworkEvent[] = [];
    transport.onEvent((payload) => {
      const parsed = NetworkEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.body.type === 'SNAPSHOT') {
        replies.push(parsed.data);
      }
    });
    await transport.connect();
    const request = NetworkEventSchema.parse({
      protocolVersion: 1,
      roomCode: code,
      roomId: null,
      senderId: sender.clientId,
      connectionId: sender.connectionId,
      hostEpoch: 0,
      sentAt: 0,
      body: { type: 'STATE_REQUEST', knownVersion: null },
    });
    for (let index = 0; index < 50; index += 1) {
      await transport.send(request);
    }
    await settle(clock);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.length).toBeLessThanOrEqual(8);
  });

  it('rejects a discovery snapshot whose broadcaster is not present', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const guest = makeSession(hub, clock, uuid, 1, {
      discoveryTimeoutMs: 1000,
    });
    const pending = guest.joinRoom('ABCDEF', 'Guest');
    await settle(clock);

    const rogue = { clientId: uid(500), connectionId: uid(600) };
    const transport = hub.create('ABCDEF', rogue);
    await transport.connect();
    const roomId = uid(900);
    const state = createInitialState({
      roomId,
      roomCode: 'ABCDEF',
      host: {
        id: rogue.clientId,
        connectionId: rogue.connectionId,
        nickname: 'Rogue',
      },
      genrePool: testCatalogue(),
      settings: DEFAULT_SETTINGS,
      at: 0,
      rngSeed: 1,
    });
    await transport.send(
      NetworkEventSchema.parse({
        protocolVersion: 1,
        roomCode: 'ABCDEF',
        roomId,
        senderId: rogue.clientId,
        connectionId: rogue.connectionId,
        hostEpoch: 0,
        sentAt: 0,
        body: {
          type: 'SNAPSHOT',
          recipientId: null,
          ackClientId: null,
          state,
        },
      }),
    );
    await settle(clock);
    clock.advance(1000);
    // The empty room is reported after the automatic retry's second window.
    await settle(clock);
    clock.advance(1000);
    await pending;
    await settle(clock);
    expect(guest.getSnapshot().error).toBe('ROOM_NOT_FOUND');
  });

  it('coalesces a same-version STATE_REQUEST flood into one chunked snapshot', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0, {
      chunkLimits: { directBytes: 256, partBytes: 128, maxParts: 64 },
    });
    await host.createRoom('Host');
    await settle(clock);
    const state = host.getSnapshot().state!;
    const code = state.roomCode;

    const rogue = { clientId: uid(500), connectionId: uid(600) };
    const transport = hub.create(code, rogue);
    const transferIds = new Set<string>();
    transport.onEvent((payload) => {
      const parsed = NetworkEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.body.type === 'SNAPSHOT_PART') {
        transferIds.add(parsed.data.body.transferId);
      }
    });
    await transport.connect();
    await settle(clock);
    transferIds.clear();

    const request = NetworkEventSchema.parse({
      protocolVersion: 1,
      roomCode: code,
      roomId: state.roomId,
      senderId: rogue.clientId,
      connectionId: rogue.connectionId,
      hostEpoch: state.hostEpoch,
      sentAt: 1000,
      body: { type: 'STATE_REQUEST', knownVersion: null },
    });
    // Deliver synchronously, before the paced sender can drain, so every
    // request sees the same logical version already in flight.
    for (let index = 0; index < 50; index += 1) {
      hub.broadcast(code, rogue.connectionId, request);
    }
    await settle(clock);

    expect(transferIds.size).toBe(1);
  });

  it('ignores a chunked discovery snapshot from a non-present sender', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const guest = makeSession(hub, clock, uuid, 1, {
      discoveryTimeoutMs: 1000,
    });
    const pending = guest.joinRoom('ABCDEF', 'Guest');
    await settle(clock, 100);

    const rogue = { clientId: uid(500), connectionId: uid(600) };
    const transport = hub.create('ABCDEF', rogue);
    await transport.connect();
    await transport.send(
      NetworkEventSchema.parse({
        protocolVersion: 1,
        roomCode: 'ABCDEF',
        roomId: uid(900),
        senderId: rogue.clientId,
        connectionId: rogue.connectionId,
        hostEpoch: 0,
        sentAt: 0,
        body: {
          type: 'SNAPSHOT_PART',
          transferId: uid(950),
          stateVersion: 0,
          index: 0,
          total: 1,
          dataBase64: 'e30=',
        },
      }),
    );
    await settle(clock);
    clock.advance(1000);
    // The empty room is reported after the automatic retry's second window.
    await settle(clock);
    clock.advance(1000);
    await pending;
    await settle(clock);
    expect(guest.getSnapshot().error).toBe('ROOM_NOT_FOUND');
  });

  it('joins the canonical chunked room despite ten live foreign first parts', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0, {
      chunkLimits: { directBytes: 256, partBytes: 1024 },
    });
    await host.createRoom('Host');
    await settle(clock);
    const state = host.getSnapshot().state!;
    const foreign = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const identity = {
          clientId: uid(500 + index),
          connectionId: uid(600 + index),
        };
        const roomId = uid(900 + index);
        const transport = hub.create(state.roomCode, identity);
        await transport.connect();
        await transport.track({ protocolVersion: 1, ...identity, roomId });
        return { identity, roomId, transport };
      }),
    );

    // Hold the honest reply until every foreign first part has arrived.
    hub.setLossy(uid(200), true);
    const guest = makeSession(hub, clock, uuid, 1);
    const joining = guest.joinRoom(state.roomCode, 'Guest');
    await settle(clock, 0);
    for (const [index, source] of foreign.entries()) {
      await source.transport.send(
        NetworkEventSchema.parse({
          protocolVersion: 1,
          roomCode: state.roomCode,
          roomId: source.roomId,
          senderId: source.identity.clientId,
          connectionId: source.identity.connectionId,
          hostEpoch: 0,
          sentAt: clock.now(),
          body: {
            type: 'SNAPSHOT_PART',
            transferId: uid(950 + index),
            stateVersion: 0,
            index: 0,
            total: 2,
            dataBase64: 'e30=',
          },
        }),
      );
    }
    hub.setLossy(uid(200), false);
    const requester = hub.create(state.roomCode, {
      clientId: uid(700),
      connectionId: uid(800),
    });
    await requester.connect();
    await requester.send(
      NetworkEventSchema.parse({
        protocolVersion: 1,
        roomCode: state.roomCode,
        roomId: null,
        senderId: uid(700),
        connectionId: uid(800),
        hostEpoch: 0,
        sentAt: clock.now(),
        body: { type: 'STATE_REQUEST', knownVersion: null },
      }),
    );
    for (
      let step = 0;
      step < 50 && guest.getSnapshot().status === 'connecting';
      step += 1
    ) {
      await settle(clock, 100);
    }
    await joining;
    expect(guest.getSnapshot().status).toBe('connected');
    expect(guest.getSnapshot().state?.roomId).toBe(state.roomId);
    expect(
      guest.getSnapshot().state?.players[guest.getSnapshot().clientId]
        ?.nickname,
    ).toBe('Guest');
  });

  it('rejects an unbound command as FORBIDDEN before consuming the limiter', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0, {
      rateLimit: { burst: 1, perSecond: 0 },
    });
    await host.createRoom('Host');
    await settle(clock);
    const state = host.getSnapshot().state!;

    const rogue = { clientId: uid(500), connectionId: uid(600) };
    const results: NetworkEvent[] = [];
    const transport = hub.create(state.roomCode, rogue);
    transport.onEvent((payload) => {
      const parsed = NetworkEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.body.type === 'COMMAND_RESULT') {
        results.push(parsed.data);
      }
    });
    await transport.connect();
    await transport.send(
      NetworkEventSchema.parse({
        protocolVersion: 1,
        roomCode: state.roomCode,
        roomId: state.roomId,
        senderId: rogue.clientId,
        connectionId: rogue.connectionId,
        hostEpoch: state.hostEpoch,
        sentAt: 1000,
        body: {
          type: 'COMMAND',
          commandId: uid(700),
          gameNumber: state.gameNumber,
          roundNumber: 0,
          command: { type: 'ADVANCE' },
        },
      }),
    );
    await settle(clock);
    expect(results).toHaveLength(1);
    expect(results[0].body).toMatchObject({
      result: { status: 'rejected', reason: 'FORBIDDEN' },
    });
  });

  it('bounds the limiter key map by evicting the oldest key', () => {
    const limiter = new RateLimiter(1, 0, 2);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 0)).toBe(false);
    expect(limiter.allow('b', 0)).toBe(true);
    expect(limiter.allow('c', 0)).toBe(true); // full -> evicts oldest ('a')
    expect(limiter.allow('a', 0)).toBe(true); // 'a' evicted -> fresh bucket
  });
});
