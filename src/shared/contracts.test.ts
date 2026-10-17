import { describe, expect, it } from 'vitest';
import { GameStateSchema, SongSchema, type GameState } from './game';
import {
  SettingsSchema,
  RequiredSettingsSchema,
  DEFAULT_SETTINGS,
} from './settings';
import { ClientActionSchema } from './actions';
import { NetworkEventSchema } from './protocol';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const roomId = '00000000-0000-4000-8000-000000000003';
const genre = { id: 'rock', de: 'Rock', en: 'Rock' };
function fixture(): GameState {
  return {
    roomId,
    roomCode: 'ABCDEF',
    stateVersion: 0,
    gameNumber: 0,
    hostId: a,
    hostEpoch: 0,
    hostBaseVersion: 0,
    settings: { ...DEFAULT_SETTINGS, genre: { mode: 'fixed', genre } },
    players: {
      [a]: {
        id: a,
        connectionId: b,
        nickname: 'Host',
        joinedAt: 0,
        status: 'player',
        connected: true,
        soundUnlocked: false,
        totalScore: 0,
      },
    },
    genrePool: [genre],
    rouletteGenrePool: Array.from({ length: 30 }, (_, index) => ({
      id: `catalogue-${index}`,
      de: `Genre ${index}`,
      en: `Genre ${index}`,
    })),
    remainingGenreIds: ['rock'],
    rngState: 1,
    phase: { type: 'LOBBY' },
    round: null,
    results: [],
    pause: null,
    forceBelowMinimum: false,
    appliedCommandIds: [],
  };
}
function playback(): GameState {
  const state = fixture();
  const media = {
    videoId: 'dQw4w9WgXcQ',
    title: 'Song',
    channel: 'Artist',
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    durationSeconds: 100,
    startSeconds: 80,
  };
  state.phase = {
    type: 'PLAYBACK',
    index: 0,
    startAt: 1000,
    deadlineAt: 21000,
    skipVoterIds: [],
  };
  state.round = {
    number: 1,
    genre,
    participantIds: [a],
    submissions: { [a]: { media, acceptedOrder: 0 } },
    submissionDoneIds: [],
    nextSubmissionOrder: 1,
    songs: [
      {
        media,
        memberVideoIds: [media.videoId],
        ownerIds: [a],
        clipSeconds: 20,
      },
    ],
    playbackOrder: [media.videoId],
    ratings: {},
  };
  return state;
}

describe('wire contracts', () => {
  it('applies local defaults but never fills omitted wire settings', () => {
    expect(SettingsSchema.parse({})).toEqual({
      genre: { mode: 'roulette' },
      rounds: 5,
      submissionSeconds: 90,
      clipSeconds: 40,
      anonymous: true,
      genreFailPenalty: -3,
      linkedPoints: 'full',
    });
    expect(RequiredSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      ClientActionSchema.safeParse({
        type: 'SET_SETTINGS',
        settings: { rounds: 5 },
      }).success,
    ).toBe(false);
  });
  it('rejects player points in a noSongs result', () => {
    const state = playback();
    state.phase = { type: 'REVEAL', startedAt: 0, deadlineAt: 5000 };
    state.round!.submissions = {};
    state.round!.songs = [];
    state.round!.playbackOrder = [];
    state.results = [
      {
        number: 1,
        genre,
        reason: 'noSongs',
        songs: [],
        playerDeltas: { [a]: 0 },
      },
    ];
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    state.results[0]!.playerDeltas[a] = 42;
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
  it('normalizes songs without memberVideoIds from older hosts', () => {
    const state = playback();
    state.phase = { type: 'REVEAL', startedAt: 0, deadlineAt: 5000 };
    const song = state.round!.songs[0]!;
    state.results = [
      {
        number: 1,
        genre,
        reason: 'normal',
        songs: [
          {
            song,
            scoreTenths: 100,
            ratingCount: 3,
            banger: true,
            basis: 'ratings',
            flaggerIds: [],
            genreFailed: false,
            winner: true,
            bonus: 20,
            ownerDeltas: { [a]: 120 },
          },
        ],
        playerDeltas: { [a]: 120 },
      },
    ];
    const legacy = structuredClone(state) as unknown as {
      round: { songs: Record<string, unknown>[] };
      results: { songs: { song: Record<string, unknown> }[] }[];
    };
    delete legacy.round.songs[0]!.memberVideoIds;
    delete legacy.results[0]!.songs[0]!.song.memberVideoIds;
    const parsed = GameStateSchema.parse(legacy);
    expect(parsed.round!.songs[0]!.memberVideoIds).toEqual([
      song.media.videoId,
    ]);
    expect(parsed.results[0]!.songs[0]!.song.memberVideoIds).toEqual([
      song.media.videoId,
    ]);
    expect(parsed).toEqual(state);
    // A present but invalid array is still rejected, never repaired.
    for (const invalid of [[], null, 'x', [song.media.videoId, 7]]) {
      legacy.round.songs[0]!.memberVideoIds = invalid;
      expect(GameStateSchema.safeParse(legacy).success).toBe(false);
    }
    delete legacy.round.songs[0]!.memberVideoIds;
    legacy.results[0]!.songs[0]!.song.memberVideoIds = [];
    expect(GameStateSchema.safeParse(legacy).success).toBe(false);
    // A decorated array is not a legacy song object, even in a valid state.
    const fields: Record<string, unknown> = { ...song };
    delete fields.memberVideoIds;
    const decorated = Object.assign([], fields);
    const withArray = structuredClone(state) as unknown as {
      round: { songs: unknown[] };
    };
    withArray.round.songs[0] = decorated;
    expect(GameStateSchema.safeParse(withArray).success).toBe(false);
    expect(SongSchema.safeParse(decorated).success).toBe(false);
  });
  it('validates scored song basis, banger and bonus invariants', () => {
    const state = playback();
    state.phase = { type: 'REVEAL', startedAt: 0, deadlineAt: 5000 };
    const song = state.round!.songs[0]!;
    const scored = {
      song,
      scoreTenths: 100,
      ratingCount: 3,
      banger: true,
      basis: 'ratings' as 'ratings' | 'noRating' | 'noRaters',
      flaggerIds: [],
      genreFailed: false,
      winner: true,
      bonus: 20,
      ownerDeltas: { [a]: 120 },
    };
    state.results = [
      {
        number: 1,
        genre,
        reason: 'normal',
        songs: [scored],
        playerDeltas: { [a]: 120 },
      },
    ];
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    const withSong = (override: Partial<typeof scored>): unknown => ({
      ...state,
      results: [
        {
          ...state.results[0]!,
          songs: [{ ...scored, ...override }],
        },
      ],
    });
    // A banger must be a full-marks ratings song.
    expect(
      GameStateSchema.safeParse(withSong({ scoreTenths: 95 })).success,
    ).toBe(false);
    // noRating must score zero.
    expect(
      GameStateSchema.safeParse(
        withSong({
          scoreTenths: 10,
          ratingCount: 0,
          banger: false,
          basis: 'noRating',
        }),
      ).success,
    ).toBe(false);
    // noRaters can never win.
    expect(
      GameStateSchema.safeParse(
        withSong({ ratingCount: 0, banger: false, basis: 'noRaters' }),
      ).success,
    ).toBe(false);
  });
  it.each([
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: 0 },
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: 10 },
  ])('accepts a valid RATE payload %#', (clientAction) => {
    expect(ClientActionSchema.safeParse(clientAction).success).toBe(true);
  });
  it.each([
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: 11 },
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: -1 },
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: 1.5 },
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: '5' },
    { type: 'RATE', value: 5 },
    { type: 'RATE', songId: 'dQw4w9WgXcQ', value: 5, extra: true },
  ])('rejects a malformed RATE payload %#', (clientAction) => {
    expect(ClientActionSchema.safeParse(clientAction).success).toBe(false);
  });
  it.each([true, false])('accepts a valid SKIP_VOTE payload %s', (skip) => {
    expect(
      ClientActionSchema.safeParse({
        type: 'SKIP_VOTE',
        songId: 'dQw4w9WgXcQ',
        skip,
      }).success,
    ).toBe(true);
  });
  it.each([
    { type: 'SKIP_VOTE', songId: 'dQw4w9WgXcQ' },
    { type: 'SKIP_VOTE', skip: true },
    { type: 'SKIP_VOTE', songId: 'dQw4w9WgXcQ', skip: 'yes' },
    { type: 'SKIP_VOTE', songId: 'short', skip: true },
    { type: 'SKIP_VOTE', songId: 'dQw4w9WgXcQ', skip: true, extra: 1 },
  ])('rejects a malformed SKIP_VOTE payload %#', (clientAction) => {
    expect(ClientActionSchema.safeParse(clientAction).success).toBe(false);
  });
  it.each([0, 21, 1.5])('rejects invalid round count %s', (rounds) =>
    expect(SettingsSchema.safeParse({ rounds }).success).toBe(false),
  );
  it.each([1, 2, 5, 10, 20])('accepts supported round count %s', (rounds) =>
    expect(SettingsSchema.parse({ rounds }).rounds).toBe(rounds),
  );
  it('rejects duplicate custom genre IDs', () =>
    expect(
      SettingsSchema.safeParse({
        genre: { mode: 'custom', items: [genre, genre] },
      }).success,
    ).toBe(false));
  it('rejects extra actor or unexpected action properties', () =>
    expect(
      ClientActionSchema.safeParse({ type: 'LEAVE', actorId: a }).success,
    ).toBe(false));
  it('accepts a coherent lobby and truncated clip', () => {
    expect(GameStateSchema.parse(fixture()).phase.type).toBe('LOBBY');
    expect(GameStateSchema.parse(playback()).round?.songs[0]?.clipSeconds).toBe(
      20,
    );
  });
  it.each([30, 50])(
    'accepts a matching roulette catalogue with %s genres',
    (count) => {
      const state = fixture();
      state.rouletteGenrePool = Array.from({ length: count }, (_, index) => ({
        id: `roulette-${index}`,
        de: `Genre ${index}`,
        en: `Genre ${index}`,
      }));
      state.settings.genre = { mode: 'roulette' };
      state.genrePool = state.rouletteGenrePool.map((item) => ({ ...item }));
      state.remainingGenreIds = state.genrePool.map((item) => item.id);
      expect(GameStateSchema.safeParse(state).success).toBe(true);
    },
  );
  it('rejects catalogues exceeding fifty genres', () => {
    const state = fixture();
    state.rouletteGenrePool = Array.from({ length: 51 }, (_, index) => ({
      id: `roulette-${index}`,
      de: `Genre ${index}`,
      en: `Genre ${index}`,
    }));
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
  it.each([
    'not-a-url',
    'http://i.ytimg.com/a.jpg',
    'https://i.ytimg.com.evil.example/a.jpg',
    'https://user:pass@i.ytimg.com/a.jpg',
  ])('rejects unsafe thumbnail %s without throwing', (thumbnail) => {
    const state = playback();
    state.round!.songs[0]!.media.thumbnail = thumbnail;
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
  it.each([
    [
      'record identity',
      (s: GameState) => {
        s.players[a]!.id = b;
      },
    ],
    [
      'missing host',
      (s: GameState) => {
        s.hostId = b;
      },
    ],
    [
      'duplicate genres',
      (s: GameState) => {
        s.genrePool.push(genre);
      },
    ],
    [
      'duplicate roulette catalogue',
      (s: GameState) => {
        s.rouletteGenrePool[1] = { ...s.rouletteGenrePool[0]! };
      },
    ],
    [
      'short roulette catalogue',
      (s: GameState) => {
        s.rouletteGenrePool.pop();
      },
    ],
    [
      'mismatched roulette active pool',
      (s: GameState) => {
        s.settings.genre = { mode: 'roulette' };
        s.genrePool = s.rouletteGenrePool.map((item) => ({
          ...item,
          id: `other-${item.id}`,
        }));
        s.remainingGenreIds = s.genrePool.map((item) => item.id);
      },
    ],
    [
      'paused lobby',
      (s: GameState) => {
        s.pause = { at: 0, reason: 'host' };
      },
    ],
    [
      'duplicate commands',
      (s: GameState) => {
        s.appliedCommandIds = [a, a];
      },
    ],
  ])('rejects incoherent %s', (_, mutate) => {
    const state = fixture();
    mutate(state);
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
  it('requires the retained catalogue on wire snapshots', () => {
    expect(
      GameStateSchema.safeParse({ ...fixture(), rouletteGenrePool: undefined })
        .success,
    ).toBe(false);
  });
  it.each([
    [
      'foreign owner',
      (s: GameState) => {
        s.round!.songs[0]!.ownerIds = [b];
      },
    ],
    [
      'duplicate owners',
      (s: GameState) => {
        s.round!.songs[0]!.ownerIds = [a, a];
      },
    ],
    [
      'clip past end',
      (s: GameState) => {
        s.round!.songs[0]!.clipSeconds = 21;
      },
    ],
    [
      'canonical id not first member',
      (s: GameState) => {
        s.round!.songs[0]!.memberVideoIds = ['otherVideo1'];
      },
    ],
    [
      'member video nobody submitted',
      (s: GameState) => {
        s.round!.songs[0]!.memberVideoIds = [
          s.round!.songs[0]!.media.videoId,
          'otherVideo1',
        ];
      },
    ],
    [
      'member video shared by two songs',
      (s: GameState) => {
        s.round!.songs.push({
          ...s.round!.songs[0]!,
          media: { ...s.round!.songs[0]!.media, videoId: 'otherVideo1' },
          memberVideoIds: ['otherVideo1', s.round!.songs[0]!.media.videoId],
        });
      },
    ],
    [
      'start at end',
      (s: GameState) => {
        s.round!.songs[0]!.media.startSeconds = 100;
      },
    ],
    [
      'bad thumbnail',
      (s: GameState) => {
        s.round!.songs[0]!.media.thumbnail = 'https://evil.example/image.jpg';
      },
    ],
    [
      'duplicate videos',
      (s: GameState) => {
        s.round!.songs.push(s.round!.songs[0]!);
      },
    ],
    [
      'bad playback index',
      (s: GameState) => {
        s.phase = {
          type: 'PLAYBACK',
          index: 1,
          startAt: 1000,
          deadlineAt: 2000,
          skipVoterIds: [],
        };
      },
    ],
    [
      'backwards deadline',
      (s: GameState) => {
        s.phase = {
          type: 'PLAYBACK',
          index: 0,
          startAt: 2000,
          deadlineAt: 1000,
          skipVoterIds: [],
        };
      },
    ],
    [
      'own song rating',
      (s: GameState) => {
        s.round!.ratings[a] = { dQw4w9WgXcQ: 5 };
      },
    ],
    [
      'own genre-fail rating',
      (s: GameState) => {
        s.round!.ratings[a] = { dQw4w9WgXcQ: 0 };
      },
    ],
    [
      'nonparticipant rating',
      (s: GameState) => {
        s.round!.ratings[b] = { dQw4w9WgXcQ: 5 };
      },
    ],
    [
      'unknown song rating',
      (s: GameState) => {
        s.round!.ratings[a] = { aaaaaaaaaaa: 5 };
      },
    ],
    [
      'out of range rating',
      (s: GameState) => {
        s.round!.ratings[a] = { dQw4w9WgXcQ: 11 };
      },
    ],
    [
      'skip vote of a nonparticipant',
      (s: GameState) => {
        s.phase = {
          type: 'PLAYBACK',
          index: 0,
          startAt: 1000,
          deadlineAt: 21000,
          skipVoterIds: [b],
        };
      },
    ],
    [
      'duplicate skip votes',
      (s: GameState) => {
        s.phase = {
          type: 'PLAYBACK',
          index: 0,
          startAt: 1000,
          deadlineAt: 21000,
          skipVoterIds: [a, a],
        };
      },
    ],
    [
      'missing playback video',
      (s: GameState) => {
        s.round!.playbackOrder = [];
      },
    ],
  ])('rejects incoherent %s', (_, mutate) => {
    const state = playback();
    mutate(state);
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
  it('accepts a SNAPSHOT from an older host without memberVideoIds', () => {
    const state = playback();
    const legacy = structuredClone(state) as unknown as {
      round: { songs: Record<string, unknown>[] };
    };
    delete legacy.round.songs[0]!.memberVideoIds;
    const parsed = NetworkEventSchema.parse({
      protocolVersion: 1,
      roomCode: state.roomCode,
      roomId,
      senderId: a,
      connectionId: b,
      hostEpoch: 0,
      sentAt: 0,
      body: {
        type: 'SNAPSHOT',
        recipientId: null,
        ackClientId: null,
        state: legacy,
      },
    });
    expect(parsed.body.type === 'SNAPSHOT' && parsed.body.state).toEqual(state);
  });
  it('limits missing roomId to discovery and verifies snapshot authority', () => {
    const state = fixture();
    const envelope = {
      protocolVersion: 1,
      roomCode: state.roomCode,
      roomId,
      senderId: a,
      connectionId: b,
      hostEpoch: 0,
      sentAt: 0,
    };
    const body = {
      type: 'SNAPSHOT',
      recipientId: null,
      ackClientId: null,
      state,
    };
    expect(NetworkEventSchema.safeParse({ ...envelope, body }).success).toBe(
      true,
    );
    expect(
      NetworkEventSchema.safeParse({ ...envelope, senderId: b, body }).success,
    ).toBe(false);
    expect(
      NetworkEventSchema.safeParse({ ...envelope, roomId: null, body }).success,
    ).toBe(false);
    expect(
      NetworkEventSchema.safeParse({
        ...envelope,
        roomId: null,
        body: { type: 'STATE_REQUEST', knownVersion: null },
      }).success,
    ).toBe(true);
  });
  it('requires a newer, same-session host connection handoff', () => {
    const state = fixture();
    const newConnection = '00000000-0000-4000-8000-000000000004';
    state.stateVersion = 1;
    state.players[a]!.connectionId = newConnection;
    const event = {
      protocolVersion: 1,
      roomCode: state.roomCode,
      roomId,
      senderId: a,
      connectionId: b,
      hostEpoch: 0,
      sentAt: 1,
      body: {
        type: 'HOST_HANDOFF',
        recipientId: a,
        baseVersion: 0,
        state,
      },
    };
    expect(NetworkEventSchema.safeParse(event).success).toBe(true);
    for (const body of [
      { ...event.body, recipientId: b },
      { ...event.body, baseVersion: 1 },
      { ...event.body, state: { ...state, roomId: newConnection } },
    ]) {
      expect(NetworkEventSchema.safeParse({ ...event, body }).success).toBe(
        false,
      );
    }
    expect(
      NetworkEventSchema.safeParse({
        ...event,
        connectionId: newConnection,
      }).success,
    ).toBe(false);
  });

  it('uses locale-independent code-unit ordering for replica ties', () => {
    const state = fixture();
    const upper = '00000000-0000-4000-8000-00000000000B';
    const lower = '00000000-0000-4000-8000-00000000000a';
    state.players[upper] = {
      ...state.players[a]!,
      id: upper,
      connectionId: '00000000-0000-4000-8000-000000000004',
      nickname: 'Upper',
      joinedAt: 1,
    };
    state.players[lower] = {
      ...state.players[a]!,
      id: lower,
      connectionId: '00000000-0000-4000-8000-000000000005',
      nickname: 'Lower',
      joinedAt: 1,
    };
    const event = {
      protocolVersion: 1,
      roomCode: state.roomCode,
      roomId,
      senderId: a,
      connectionId: b,
      hostEpoch: 0,
      sentAt: 1,
      body: { type: 'SNAPSHOT', recipientId: null, ackClientId: upper, state },
    };
    expect(NetworkEventSchema.safeParse(event).success).toBe(true);
    expect(
      NetworkEventSchema.safeParse({
        ...event,
        body: { ...event.body, ackClientId: lower },
      }).success,
    ).toBe(false);
  });
  it('rejects invalid fragment indices and unsupported protocol versions', () => {
    const envelope = {
      protocolVersion: 1,
      roomCode: 'ABCDEF',
      roomId,
      senderId: a,
      connectionId: b,
      hostEpoch: 0,
      sentAt: 0,
      body: {
        type: 'SNAPSHOT_PART',
        transferId: a,
        stateVersion: 1,
        index: 1,
        total: 1,
        dataBase64: 'e30=',
      },
    };
    expect(NetworkEventSchema.safeParse(envelope).success).toBe(false);
    expect(
      NetworkEventSchema.safeParse({
        ...envelope,
        protocolVersion: 2,
        body: { ...envelope.body, index: 0 },
      }).success,
    ).toBe(false);
  });
});
