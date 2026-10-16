import { describe, expect, it } from 'vitest';
import type { GameState } from '../shared/game';
import { NetworkEventSchema } from '../shared/protocol';
import type { GameSession } from './session';
import { InMemoryHub } from './inMemory';
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

function deadlineOf(state: GameState): number {
  const phase = state.phase;
  if ('deadlineAt' in phase) {
    return phase.deadlineAt;
  }
  throw new Error('phase has no deadline');
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

function media(index: number) {
  const videoId = `v${index.toString().padStart(10, '0')}`;
  return {
    videoId,
    title: `Song ${index}`,
    channel: 'Artist',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: 100,
    startSeconds: 10,
  };
}

interface PlayingGame {
  host: GameSession;
  guests: GameSession[];
  hostConnectionId: string;
}

async function buildPlayingGame(
  hub: InMemoryHub,
  clock: ManualClock,
  uuid: () => string,
): Promise<PlayingGame> {
  const host = makeSession(hub, clock, uuid, 0);
  const guests = [1, 2, 3].map((n) => makeSession(hub, clock, uuid, n));
  await host.createRoom('Host');
  await settle(clock);
  const code = host.getSnapshot().roomCode!;
  for (const [index, guest] of guests.entries()) {
    await guest.joinRoom(code, `G${index}`);
    await settle(clock);
  }
  for (const session of [host, ...guests]) {
    await session.dispatch({ type: 'SOUND_STATUS', unlocked: true });
  }
  await settle(clock);
  await host.dispatch({ type: 'START_GAME' });
  await settle(clock);
  await host.dispatch({ type: 'ADVANCE' });
  await settle(clock);

  const submitters = [host, ...guests];
  for (const [index, session] of submitters.entries()) {
    await session.dispatch({ type: 'SUBMIT_SONG', media: media(index + 1) });
    await settle(clock);
    await session.dispatch({ type: 'FINISH_SUBMISSION' });
    await settle(clock);
  }

  for (let step = 0; step < 10; step += 1) {
    const current = host.getSnapshot().state;
    if (
      current?.phase.type === 'PLAYBACK' &&
      current.phase.index === current.round!.playbackOrder.length - 1
    ) {
      break;
    }
    await host.dispatch({ type: 'ADVANCE' });
    await settle(clock);
  }
  const open = host.getSnapshot().state!;
  expect(open.phase.type).toBe('PLAYBACK');
  expect(open.phase.type === 'PLAYBACK' && open.phase.index).toBe(
    open.round!.playbackOrder.length - 1,
  );
  return { host, guests, hostConnectionId: uid(200) };
}

describe('host migration', () => {
  it('moves authority to the oldest participant, preserving drafts and phase', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const { host, guests, hostConnectionId } = await buildPlayingGame(
      hub,
      clock,
      uuid,
    );
    const deadlineAt = deadlineOf(host.getSnapshot().state!);

    hub.simulateDrop(hostConnectionId);
    await settle(clock);
    clock.advance(250);
    await settle(clock);

    const successor = guests[0];
    const successorState = successor.getSnapshot().state!;
    expect(successorState.hostId).toBe(successor.getSnapshot().clientId);
    expect(successorState.hostEpoch).toBe(1);
    expect(successorState.phase.type).toBe('PLAYBACK');
    expect(deadlineOf(successorState)).toBe(deadlineAt);
    expect(Object.keys(successorState.round!.submissions)).toHaveLength(4);
    expect(guests[1].getSnapshot().state?.hostId).toBe(
      successor.getSnapshot().clientId,
    );
    expect(guests[2].getSnapshot().state?.hostId).toBe(
      successor.getSnapshot().clientId,
    );
  });

  it('adopts a replica snapshot newer than the candidate', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const { guests, hostConnectionId } = await buildPlayingGame(
      hub,
      clock,
      uuid,
    );
    const candidate = guests[0];
    const candidateConnectionId = uid(201);
    hub.setLossy(candidateConnectionId, true);
    const playing = guests[0].getSnapshot().state!;
    const openVideo =
      playing.round!.playbackOrder[playing.round!.playbackOrder.length - 1];
    const owner = playing.round!.songs.find(
      (song) => song.media.videoId === openVideo,
    )!.ownerIds[0];
    const rater = guests
      .slice(1)
      .find((guest) => guest.getSnapshot().clientId !== owner)!;
    await rater.dispatch({ type: 'RATE', songId: openVideo, value: 8 });
    await settle(clock);
    hub.setLossy(candidateConnectionId, false);

    hub.simulateDrop(hostConnectionId);
    await settle(clock);
    clock.advance(250);
    await settle(clock);

    const successorState = candidate.getSnapshot().state!;
    expect(successorState.hostId).toBe(candidate.getSnapshot().clientId);
    // The rating the candidate missed was carried by the newer replica.
    expect(
      successorState.round!.ratings[rater.getSnapshot().clientId]?.[openVideo],
    ).toBe(8);
  });

  it('keeps a paused phase and its frozen deadline across migration', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const guests = [1, 2, 3].map((n) => makeSession(hub, clock, uuid, n));
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    for (const [index, guest] of guests.entries()) {
      await guest.joinRoom(code, `G${index}`);
      await settle(clock);
    }
    for (const session of [host, ...guests]) {
      await session.dispatch({ type: 'SOUND_STATUS', unlocked: true });
    }
    await settle(clock);
    await host.dispatch({ type: 'START_GAME' });
    await settle(clock);
    await host.dispatch({ type: 'PAUSE' });
    await settle(clock);
    const pausedState = host.getSnapshot().state!;
    expect(pausedState.pause?.reason).toBe('host');
    const deadlineAt = deadlineOf(pausedState);

    hub.simulateDrop(uid(200));
    await settle(clock);
    clock.advance(250);
    await settle(clock);

    const successorState = guests[0].getSnapshot().state!;
    expect(successorState.hostId).toBe(guests[0].getSnapshot().clientId);
    expect(successorState.pause?.reason).toBe('host');
    expect(deadlineOf(successorState)).toBe(deadlineAt);
    expect(host.getSnapshot().state?.phase.type).toBe('GENRE_SPIN');
  });

  it('a host that reconnects after a migration yields to the new lineage', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const { host, guests, hostConnectionId } = await buildPlayingGame(
      hub,
      clock,
      uuid,
    );

    hub.simulateDrop(hostConnectionId);
    await settle(clock);
    clock.advance(250);
    await settle(clock);
    const newHost = guests[0];
    expect(newHost.getSnapshot().state?.hostEpoch).toBe(1);
    const newHostId = newHost.getSnapshot().clientId;

    // The original host tab reconnects: it must not republish stale authority.
    hub.simulateRestore(hostConnectionId);
    await settle(clock);
    await settle(clock);

    const state = host.getSnapshot().state!;
    expect(state.hostEpoch).toBe(1);
    expect(state.hostId).toBe(newHostId);
    expect(host.getSnapshot().status).not.toBe('lost');
    // Demoted to a player, it can still act through the new host.
    await settle(clock);
    const result = await host.dispatch({
      type: 'SOUND_STATUS',
      unlocked: false,
    });
    await settle(clock);
    expect(result.status).toBe('accepted');
  });

  it('a solo host that drops and restores can still change settings', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    await host.createRoom('Host');
    await settle(clock);
    const settings = host.getSnapshot().state!.settings;

    hub.simulateDrop(uid(200));
    await settle(clock);
    hub.simulateRestore(uid(200));
    await settle(clock);
    // No peer answers within the reclaim window, so the host reclaims itself.
    clock.advance(7000);
    await settle(clock);

    expect(host.getSnapshot().status).toBe('connected');
    // Its own presence must be back, or the engine would see it disconnected.
    const code = host.getSnapshot().roomCode!;
    expect(
      hub.presencePayloads(code).some((p) => p.connectionId === uid(200)),
    ).toBe(true);
    expect(
      host.getSnapshot().state?.players[host.getSnapshot().clientId]?.connected,
    ).toBe(true);
    const result = await host.dispatch({
      type: 'SET_SETTINGS',
      settings: { ...settings, rounds: 3 },
    });
    await settle(clock);
    expect(result.status).toBe('accepted');
    expect(host.getSnapshot().state?.settings.rounds).toBe(3);
  });

  it.each([1, 5])(
    'an epoch +%i snapshot cannot preempt a present confirmed host',
    async (epochStep) => {
      const clock = new ManualClock(CLOCK_START);
      const hub = new InMemoryHub();
      const uuid = uuidFactory();
      const { guests, hostConnectionId } = await buildPlayingGame(
        hub,
        clock,
        uuid,
      );

      hub.simulateDrop(hostConnectionId);
      await settle(clock);
      clock.advance(250);
      await settle(clock);
      const newHost = guests[0];
      const newHostState = newHost.getSnapshot().state!;
      expect(newHostState.hostEpoch).toBe(1);
      const newHostClientId = newHost.getSnapshot().clientId;

      // The older (original) host's presence returns while the younger confirmed
      // host is still present. It is the deterministic election winner by
      // (joinedAt, clientId), so only the incumbent-present guard stops it.
      const older = { clientId: uid(100), connectionId: hostConnectionId };
      const transport = hub.create(newHostState.roomCode, older);
      await transport.connect();
      await transport.track({
        protocolVersion: 1,
        clientId: older.clientId,
        connectionId: older.connectionId,
        roomId: newHostState.roomId,
      });
      await settle(clock);

      const forged = structuredClone(newHostState);
      forged.hostEpoch = newHostState.hostEpoch + epochStep;
      forged.stateVersion = newHostState.stateVersion + 1;
      forged.hostId = older.clientId;
      hub.broadcast(
        newHostState.roomCode,
        older.connectionId,
        NetworkEventSchema.parse({
          protocolVersion: 1,
          roomCode: newHostState.roomCode,
          roomId: newHostState.roomId,
          senderId: older.clientId,
          connectionId: older.connectionId,
          hostEpoch: forged.hostEpoch,
          sentAt: 1000,
          body: {
            type: 'SNAPSHOT',
            recipientId: null,
            ackClientId: newHostClientId,
            state: forged,
          },
        }),
      );
      await settle(clock);

      // The confirmed host's own connection is still present: no preemption.
      expect(newHost.getSnapshot().state?.hostEpoch).toBe(1);
      expect(newHost.getSnapshot().state?.hostId).toBe(newHostClientId);
      for (const client of guests.slice(1)) {
        expect(client.getSnapshot().state?.hostEpoch).toBe(1);
        expect(client.getSnapshot().state?.hostId).toBe(newHostClientId);
      }
    },
  );

  it('an idle-lobby host yields to the new epoch after reconnecting', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const guests = [1, 2, 3].map((n) => makeSession(hub, clock, uuid, n));
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    for (const [index, guest] of guests.entries()) {
      await guest.joinRoom(code, `G${index}`);
      await settle(clock);
    }
    // No further commands: the new host inherits an idle lobby.
    hub.simulateDrop(uid(200));
    await settle(clock);
    clock.advance(250);
    await settle(clock);
    const newHost = guests[0];
    expect(newHost.getSnapshot().state?.hostEpoch).toBe(1);
    const newHostId = newHost.getSnapshot().clientId;

    hub.simulateRestore(uid(200));
    await settle(clock);
    await settle(clock);

    const state = host.getSnapshot().state!;
    expect(state.hostEpoch).toBe(1);
    expect(state.hostId).toBe(newHostId);
    expect(host.getSnapshot().status).not.toBe('lost');
  });

  it('a stale read-only tab does not claim alongside the bound tab', async () => {
    const clock = new ManualClock(CLOCK_START);
    const hub = new InMemoryHub();
    const uuid = uuidFactory();
    const host = makeSession(hub, clock, uuid, 0);
    const guests = [1, 2, 3].map((n) => makeSession(hub, clock, uuid, n));
    await host.createRoom('Host');
    await settle(clock);
    const code = host.getSnapshot().roomCode!;
    for (const [index, guest] of guests.entries()) {
      await guest.joinRoom(code, `G${index}`);
      await settle(clock);
    }

    // A second tab of guest 0 joins, rebinding the identity to a new
    // connection; the original tab becomes read-only before the host closes.
    const oldB = guests[0];
    const clientIdB = oldB.getSnapshot().clientId;
    const boundB = createTestSession({
      hub,
      clock,
      uuid,
      clientId: clientIdB,
      connectionId: uid(250),
    });
    await boundB.joinRoom(code, '');
    await settle(clock);
    expect(host.getSnapshot().state?.players[clientIdB]?.connectionId).toBe(
      uid(250),
    );

    hub.simulateDrop(uid(200));
    await settle(clock);
    clock.advance(250);
    await settle(clock);
    clock.advance(1000);
    await settle(clock);

    // Only the bound tab becomes the new host; the stale tab stays a client
    // and mirrors the new epoch instead of freezing on its own stale state.
    expect(boundB.getSnapshot().state?.hostEpoch).toBe(1);
    expect(oldB.getSnapshot().status).toBe('connected');
    expect(oldB.getSnapshot().state?.hostEpoch).toBe(1);

    const settings = { ...host.getSnapshot().state!.settings, rounds: 6 };
    const result = await boundB.dispatch({ type: 'SET_SETTINGS', settings });
    await settle(clock);
    expect(result.status).toBe('accepted');
    expect(oldB.getSnapshot().state?.settings.rounds).toBe(6);
    expect(oldB.getSnapshot().state?.hostEpoch).toBe(1);
  });
});
