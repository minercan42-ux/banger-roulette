import { describe, expect, it } from 'vitest';
import {
  command,
  fireDeadline,
  makeSettings,
  media,
  newGame,
  startGame,
  validationError,
  videoId,
} from '../engine/fixtures';
import type { GameState } from '../shared/game';
import { NetworkEventSchema, type NetworkEvent } from '../shared/protocol';
import {
  ChunkError,
  DEFAULT_CHUNK_LIMITS,
  DIRECT_BYTES,
  MAX_PARTS,
  MAX_TOTAL_BYTES,
  PART_EXPIRY_MS,
  Reassembler,
  encodeEvent,
  type ChunkLimits,
} from './chunk';
import { ManualClock } from './testkit';

function phaseDeadline(state: GameState): number {
  return 'deadlineAt' in state.phase ? state.phase.deadlineAt : 0;
}

/** Plays a full game with long (schema-max) consumer metadata. */
function playRounds(rounds: number, players: number): GameState {
  let state = startGame(
    newGame({ players, settings: makeSettings({ rounds }) }),
    1000,
  );
  for (let round = 0; round < rounds; round += 1) {
    if (state.phase.type === 'GENRE_SPIN') {
      state = fireDeadline(state);
    }
    const submitAt = phaseDeadline(state) - 2;
    state.round!.participantIds.forEach((playerId, index) => {
      state = command(
        state,
        playerId,
        {
          type: 'SUBMIT_SONG',
          media: media(videoId(round * 100 + index + 1), {
            title: 'T'.repeat(500),
            channel: 'C'.repeat(200),
          }),
        },
        submitAt,
      );
      state = command(state, playerId, { type: 'FINISH_SUBMISSION' }, submitAt);
    });
    for (
      let step = 0;
      step < 20 && state.phase.type === 'PLAYBACK';
      step += 1
    ) {
      state = fireDeadline(state);
    }
    if (state.phase.type !== 'VOTING') {
      throw new Error(
        `round ${round} did not reach voting: ${state.phase.type}`,
      );
    }
    const voteAt = phaseDeadline(state) - 2;
    const songs = state.round!.songs;
    for (const playerId of state.round!.participantIds) {
      const foreign = songs
        .filter((song) => !song.ownerIds.includes(playerId))
        .map((song) => song.media.videoId);
      state = command(
        state,
        playerId,
        { type: 'SET_RANKING', ranking: foreign },
        voteAt,
      );
      state = command(state, playerId, { type: 'FINISH_VOTING' }, voteAt);
    }
    if (state.phase.type === 'REVEAL') {
      state = fireDeadline(state);
    }
  }
  return state;
}

/** Small limits so a realistic snapshot actually chunks in the test. */
const LIMITS: ChunkLimits = {
  directBytes: 200,
  partBytes: 120,
  maxParts: 128,
  expiryMs: 5000,
};

function replicaId(state: GameState): string | null {
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

function snapshotEvent(state: GameState): NetworkEvent {
  return NetworkEventSchema.parse({
    protocolVersion: 1,
    roomCode: state.roomCode,
    roomId: state.roomId,
    senderId: state.hostId,
    connectionId: state.players[state.hostId].connectionId,
    hostEpoch: state.hostEpoch,
    sentAt: 1000,
    body: {
      type: 'SNAPSHOT',
      recipientId: null,
      ackClientId: replicaId(state),
      state,
    },
  });
}

interface Reassembly {
  event: NetworkEvent | null;
  failures: number;
}

function collect(
  frames: NetworkEvent[],
  clock: ManualClock,
  limits: ChunkLimits = LIMITS,
): Reassembly {
  const reassembler = new Reassembler(clock, limits);
  const result: Reassembly = { event: null, failures: 0 };
  for (const frame of frames) {
    reassembler.feed(frame, {
      onComplete: (event) => {
        result.event = event;
      },
      onFailure: () => {
        result.failures += 1;
      },
    });
  }
  return result;
}

describe('snapshot chunk codec', () => {
  it('sends a small body as a single direct frame', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(
      event,
      { ...LIMITS, directBytes: 10_000_000 },
      'x',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].body.type).toBe('SNAPSHOT');
  });

  it('chunks and reassembles a snapshot losslessly', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-1');
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.body.type === 'SNAPSHOT_PART')).toBe(
      true,
    );

    const result = collect(frames, new ManualClock());
    expect(result.failures).toBe(0);
    expect(result.event?.body).toEqual(event.body);
  });

  it('reassembles out-of-order parts', () => {
    const event = snapshotEvent(newGame());
    const frames = [...encodeEvent(event, LIMITS, 'transfer-2')].reverse();
    const result = collect(frames, new ManualClock());
    expect(result.event?.body).toEqual(event.body);
  });

  it('ignores an identical duplicate part', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-3');
    const duplicated = [frames[0], frames[0], ...frames.slice(1)];
    const result = collect(duplicated, new ManualClock());
    expect(result.failures).toBe(0);
    expect(result.event?.body).toEqual(event.body);
  });

  it('discards a conflicting duplicate part', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-4');
    const conflicting = frames.map((frame, index) =>
      index === 0 && frame.body.type === 'SNAPSHOT_PART'
        ? {
            ...frame,
            body: { ...frame.body, dataBase64: 'AAAA' },
          }
        : frame,
    );
    const result = collect(
      [frames[0], conflicting[0], ...frames.slice(1)],
      new ManualClock(),
    );
    expect(result.failures).toBeGreaterThan(0);
    expect(result.event).toBeNull();
  });

  it('discards parts whose envelope identity does not match', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-5');
    const mismatched = frames.map((frame, index) =>
      index === 1 ? { ...frame, hostEpoch: frame.hostEpoch + 1 } : frame,
    );
    const result = collect(mismatched, new ManualClock());
    expect(result.failures).toBeGreaterThan(0);
    expect(result.event).toBeNull();
  });

  it('expires an incomplete transfer after the TTL', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-6');
    const clock = new ManualClock();
    const reassembler = new Reassembler(clock, LIMITS);
    let failures = 0;
    let completed = false;
    reassembler.feed(frames[0], {
      onComplete: () => {
        completed = true;
      },
      onFailure: () => {
        failures += 1;
      },
    });
    clock.advance(LIMITS.expiryMs);
    expect(failures).toBe(1);
    expect(completed).toBe(false);
  });

  it('completes a transfer longer than the TTL when parts keep arriving', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-long');
    expect(frames.length).toBeGreaterThan(1);
    const clock = new ManualClock();
    const reassembler = new Reassembler(clock, LIMITS);
    const completed: NetworkEvent[] = [];
    let failures = 0;
    frames.forEach((frame, index) => {
      reassembler.feed(frame, {
        onComplete: (value) => {
          completed.push(value);
        },
        onFailure: () => {
          failures += 1;
        },
      });
      if (index < frames.length - 1) {
        clock.advance(LIMITS.expiryMs - 1000);
      }
    });
    expect(failures).toBe(0);
    expect(completed.map((frame) => frame.body)).toEqual([event.body]);
    expect((frames.length - 1) * (LIMITS.expiryMs - 1000)).toBeGreaterThan(
      LIMITS.expiryMs,
    );
  });

  it('does not let identical duplicates extend the expiry', () => {
    const event = snapshotEvent(newGame());
    const frames = encodeEvent(event, LIMITS, 'transfer-dup');
    const clock = new ManualClock();
    const reassembler = new Reassembler(clock, LIMITS);
    let failures = 0;
    const hooks = {
      onComplete: () => undefined,
      onFailure: () => {
        failures += 1;
      },
    };
    reassembler.feed(frames[0], hooks);
    clock.advance(3000);
    reassembler.feed(frames[0], hooks);
    clock.advance(3000);
    expect(failures).toBe(1);
  });

  it('refuses to encode a transfer beyond the part budget', () => {
    const event = snapshotEvent(newGame());
    expect(() =>
      encodeEvent(
        event,
        { ...LIMITS, partBytes: 20, maxParts: 1 },
        'transfer-7',
      ),
    ).toThrow(ChunkError);
  });

  it('bounds concurrent reassemblies per sender and globally', () => {
    const limits: ChunkLimits = {
      ...LIMITS,
      maxAssembliesPerSender: 1,
      maxAssemblies: 2,
    };
    const reassembler = new Reassembler(new ManualClock(), limits);
    const part = (sender: string, transfer: string): NetworkEvent =>
      NetworkEventSchema.parse({
        protocolVersion: 1,
        roomCode: 'ABCDEF',
        roomId: '00000000-0000-4000-8000-0000000000ff',
        senderId: sender,
        connectionId: sender,
        hostEpoch: 0,
        sentAt: 0,
        body: {
          type: 'SNAPSHOT_PART',
          transferId: transfer,
          stateVersion: 1,
          index: 0,
          total: 2,
          dataBase64: 'AAAA',
        },
      });
    const hooks = { onComplete: () => undefined, onFailure: () => undefined };
    const s1 = '00000000-0000-4000-8000-000000000001';
    const s2 = '00000000-0000-4000-8000-000000000002';
    const s3 = '00000000-0000-4000-8000-000000000003';
    reassembler.feed(part(s1, '00000000-0000-4000-8000-0000000000a1'), hooks);
    expect(reassembler.count()).toBe(1);
    reassembler.feed(part(s1, '00000000-0000-4000-8000-0000000000a2'), hooks);
    expect(reassembler.count()).toBe(1);
    reassembler.feed(part(s2, '00000000-0000-4000-8000-0000000000a3'), hooks);
    expect(reassembler.count()).toBe(2);
    reassembler.feed(part(s3, '00000000-0000-4000-8000-0000000000a4'), hooks);
    expect(reassembler.count()).toBe(2);
  });

  it('fits a full twenty-round consumer state within the codec and TTL', () => {
    const state = playRounds(20, 10);
    expect(state.phase).toEqual({ type: 'FINAL', reason: 'completed' });
    expect(state.results).toHaveLength(20);
    expect(validationError(state)).toBeNull();

    const event = snapshotEvent(state);
    const bytes = new TextEncoder().encode(JSON.stringify(event.body));
    expect(bytes.length).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    const frames = encodeEvent(event, DEFAULT_CHUNK_LIMITS, 'twenty-round');
    expect(frames.length).toBeLessThanOrEqual(MAX_PARTS);
    if (bytes.length <= DIRECT_BYTES) {
      expect(frames).toHaveLength(1);
    } else {
      // Ten peers -> 10 frames/s; the largest gap between consecutive parts is
      // one batch interval (8 frames) and must stay under the sliding TTL.
      const interval = Math.round((8 / (100 / 10)) * 1000);
      expect(interval).toBeLessThan(PART_EXPIRY_MS);
    }
  });
});
