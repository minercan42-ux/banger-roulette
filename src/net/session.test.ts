import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { NetworkEventSchema, type NetworkEvent } from '../shared/protocol';
import type { ClientAction } from '../shared/actions';
import { InMemoryHub } from './inMemory';
import type { GameSession } from './session';
import {
  ManualClock,
  createTestSession,
  settle,
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

function scripted(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function commandEvent(
  state: {
    roomCode: string;
    roomId: string;
    hostId: string;
    hostEpoch: number;
    gameNumber: number;
    round: { number: number } | null;
  },
  sender: { clientId: string; connectionId: string },
  commandId: string,
  command: ClientAction,
  overrides: { gameNumber?: number; roundNumber?: number } = {},
): NetworkEvent {
  return NetworkEventSchema.parse({
    protocolVersion: 1,
    roomCode: state.roomCode,
    roomId: state.roomId,
    senderId: sender.clientId,
    connectionId: sender.connectionId,
    hostEpoch: state.hostEpoch,
    sentAt: 1000,
    body: {
      type: 'COMMAND',
      commandId,
      gameNumber: overrides.gameNumber ?? state.gameNumber,
      roundNumber: overrides.roundNumber ?? state.round?.number ?? 0,
      command,
    },
  });
}

describe('game session', () => {
  it('creates a room and joins it, publishing live snapshots', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const guest = makeSession(hub, clock, uuid, 1);

    await host.createRoom('Host');
    await settle(clock);
    const hostSnapshot = host.getSnapshot();
    expect(hostSnapshot.status).toBe('connected');
    expect(hostSnapshot.state?.hostId).toBe(hostSnapshot.clientId);
    expect(hostSnapshot.roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);

    const code = hostSnapshot.roomCode!;
    await guest.joinRoom(code, 'Guest');
    await settle(clock);

    const guestState = guest.getSnapshot().state;
    expect(guest.getSnapshot().status).toBe('connected');
    expect(guestState?.players[guest.getSnapshot().clientId]?.nickname).toBe(
      'Guest',
    );
    expect(Object.keys(host.getSnapshot().state!.players)).toHaveLength(2);
  });

  it('resolves a room-code collision by the smallest roomId', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const sameCode = '00000000-0000-4000-8000-00000000000a';
    const a = makeSession(
      hub,
      clock,
      scripted([sameCode, uid(1), uid(101)]),
      0,
    );
    const b = makeSession(
      hub,
      clock,
      scripted([sameCode, uid(2), uid(102), uid(3), uid(103)]),
      1,
    );

    await Promise.all([a.createRoom('A'), b.createRoom('B')]);
    await settle(clock);

    expect(a.getSnapshot().roomCode).toBe('AAAAAA');
    expect(b.getSnapshot().roomCode).not.toBe('AAAAAA');
    expect(b.getSnapshot().roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(a.getSnapshot().status).toBe('connected');
    expect(b.getSnapshot().status).toBe('connected');
  });

  it('hands host authority to a second tab of the same client', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    const clientId = host.getSnapshot().clientId;

    const successor = createTestSession({
      hub,
      clock,
      uuid,
      clientId,
      connectionId: uid(300),
    });
    await successor.joinRoom(code, '');
    await settle(clock);

    expect(host.getSnapshot().state?.players[clientId]?.connectionId).toBe(
      successor.getSnapshot().connectionId,
    );
    expect(successor.getSnapshot().state?.hostId).toBe(clientId);

    // The successor is now authoritative and can change host-only settings.
    const settings = { ...DEFAULT_SETTINGS, rounds: 7 };
    const result = await successor.dispatch({ type: 'SET_SETTINGS', settings });
    await settle(clock);
    expect(result).toEqual({
      status: 'accepted',
      stateVersion: expect.any(Number),
    });
    expect(host.getSnapshot().state?.settings.rounds).toBe(7);
  });

  it('rejects an eleventh active participant with ROOM_FULL', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    for (let index = 1; index <= 9; index += 1) {
      const guest = makeSession(hub, clock, uuid, index);
      await guest.joinRoom(code, `G${index}`);
      await settle(clock);
    }
    const overflow = makeSession(hub, clock, uuid, 50);
    await overflow.joinRoom(code, 'Overflow');
    await settle(clock);
    expect(overflow.getSnapshot().error).toBe('ROOM_FULL');
  });

  it('rate limits a client per burst', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0, {
      rateLimit: { burst: 2, perSecond: 0 },
    });
    const guest = makeSession(hub, clock, uuid, 1);
    await host.createRoom('Host');
    await settle(clock);
    await guest.joinRoom(host.getSnapshot().roomCode!, 'Guest');
    await settle(clock);

    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(
        await guest.dispatch({ type: 'SOUND_STATUS', unlocked: true }),
      );
      await settle(clock);
    }
    expect(results[0]).toEqual({
      status: 'accepted',
      stateVersion: expect.any(Number),
    });
    expect(results[2]).toEqual({ status: 'rejected', reason: 'RATE_LIMITED' });
    expect(results[3]).toEqual({ status: 'rejected', reason: 'RATE_LIMITED' });
  });

  it('rejects a stale game number', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const state = host.getSnapshot().state!;

    const sender = { clientId: uid(500), connectionId: uid(600) };
    const transport = hub.create(state.roomCode, sender);
    await transport.connect();
    await transport.track({
      protocolVersion: 1,
      ...sender,
      roomId: state.roomId,
    });
    await transport.send(
      commandEvent(state, sender, uid(701), {
        type: 'JOIN',
        nickname: 'Guest',
      }),
    );
    await settle(clock);
    const results: NetworkEvent[] = [];
    transport.onEvent((payload) => {
      const parsed = NetworkEventSchema.safeParse(payload);
      if (
        parsed.success &&
        parsed.data.body.type === 'COMMAND_RESULT' &&
        parsed.data.body.commandId === uid(700)
      ) {
        results.push(parsed.data);
      }
    });
    await transport.send(
      commandEvent(
        state,
        sender,
        uid(700),
        { type: 'LEAVE' },
        { gameNumber: state.gameNumber + 1 },
      ),
    );
    await settle(clock);
    expect(results[0]?.body).toMatchObject({
      type: 'COMMAND_RESULT',
      result: { status: 'rejected', reason: 'STALE' },
    });
    expect(host.getSnapshot().state?.players[sender.clientId]).toMatchObject({
      connected: true,
      status: 'player',
    });
  });

  it('serves a cached replay without a second mutation', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const state = host.getSnapshot().state!;
    const sender = { clientId: uid(500), connectionId: uid(600) };
    const event = commandEvent(state, sender, uid(701), {
      type: 'JOIN',
      nickname: 'Raw',
    });

    const transport = hub.create(state.roomCode, sender);
    const results: NetworkEvent[] = [];
    transport.onEvent((payload) => {
      const parsed = NetworkEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.body.type === 'COMMAND_RESULT') {
        results.push(parsed.data);
      }
    });
    await transport.connect();
    await transport.send(event);
    await settle(clock);
    await transport.send(event);
    await settle(clock);

    expect(results).toHaveLength(2);
    expect(Object.keys(host.getSnapshot().state!.players)).toHaveLength(2);
    expect(
      host
        .getSnapshot()
        .state!.appliedCommandIds.filter((id) => id === uid(701)),
    ).toHaveLength(1);
  });

  it('fires phase deadlines from the host clock', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const a = makeSession(hub, clock, uuid, 1);
    const b = makeSession(hub, clock, uuid, 2);
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    await a.joinRoom(code, 'A');
    await settle(clock);
    await b.joinRoom(code, 'B');
    await settle(clock);
    for (const session of [host, a, b]) {
      await session.dispatch({ type: 'SOUND_STATUS', unlocked: true });
    }
    await settle(clock);
    await host.dispatch({ type: 'START_GAME' });
    await settle(clock);
    expect(host.getSnapshot().state?.phase.type).toBe('GENRE_SPIN');

    clock.advance(3000);
    await settle(clock);
    expect(host.getSnapshot().state?.phase.type).toBe('SUBMISSION');
    expect(a.getSnapshot().state?.phase.type).toBe('SUBMISSION');
  });

  it('reports ROOM_NOT_FOUND when no host answers discovery', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const guest = makeSession(hub, clock, uuid, 1, { discoveryTimeoutMs: 100 });
    const pending = guest.joinRoom('ZZZZZZ', 'Nobody');
    await settle(clock);
    clock.advance(100);
    await pending;
    await settle(clock);
    expect(guest.getSnapshot().error).toBe('ROOM_NOT_FOUND');
  });

  it('rejects a malformed room code', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const guest = makeSession(hub, clock, uuid, 1);
    await guest.joinRoom('abc', 'Nobody');
    expect(guest.getSnapshot().error).toBe('INVALID_ROOM_CODE');
  });

  it('delivers a chunked snapshot to a joining client', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const chunkLimits = {
      directBytes: 100,
      partBytes: 120,
      maxParts: 128,
      expiryMs: 5000,
    };
    const host = makeSession(hub, clock, uuid, 0, { chunkLimits });
    const guest = makeSession(hub, clock, uuid, 1, { chunkLimits });
    await host.createRoom('Host');
    await settle(clock);
    // The chunked snapshot is paced, so drive the ManualClock while the join
    // is pending; the session must not report 'connected' until it lands.
    const pending = guest.joinRoom(host.getSnapshot().roomCode!, 'Guest');
    await settle(clock, 1000);
    await settle(clock, 1000);
    await settle(clock, 1000);
    await pending;
    await settle(clock);
    expect(guest.getSnapshot().status).toBe('connected');
    expect(Object.keys(guest.getSnapshot().state!.players)).toHaveLength(2);
  });

  it('finishes a superseded unknown-room join instead of hanging', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const session = makeSession(hub, clock, uuid, 1, {
      discoveryTimeoutMs: 4000,
    });

    const first = session.joinRoom('ABCDEF', 'One');
    await settle(clock, 100);
    // A second join supersedes the first while its discovery is still open.
    const second = session.joinRoom('GHJKLM', 'Two');
    await settle(clock);
    clock.advance(5000);
    await settle(clock);

    await Promise.all([first, second]);
    expect(session.getSnapshot().error).toBe('ROOM_NOT_FOUND');
  });

  it('a client reconnecting under a recent resync keeps presence and can act', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const guest = makeSession(hub, clock, uuid, 1);
    await host.createRoom('Host');
    await settle(clock);
    await guest.joinRoom(host.getSnapshot().roomCode!, 'Guest');
    await settle(clock);
    const guestId = guest.getSnapshot().clientId;

    // Two blips well inside the resync throttle window: presence must be
    // restored independently of request coalescing.
    for (let blip = 0; blip < 2; blip += 1) {
      hub.simulateDrop(uid(201));
      await settle(clock, 100);
      hub.simulateRestore(uid(201));
      await settle(clock, 100);
    }
    await settle(clock);

    expect(host.getSnapshot().state?.players[guestId]?.connected).toBe(true);
    const result = await guest.dispatch({
      type: 'SOUND_STATUS',
      unlocked: true,
    });
    await settle(clock);
    expect(result.status).toBe('accepted');
  });
});
