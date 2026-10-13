import { describe, expect, it } from 'vitest';
import type { GameState } from '../shared/game';
import {
  classifyCommand,
  createInitialState,
  electHost,
  reducer,
} from './index';
import {
  ROOM_ID,
  action,
  activeCount,
  allConnections,
  command,
  completedFinalState,
  finalState,
  fireDeadline,
  genre,
  hostAdvance,
  id,
  makeSettings,
  media,
  newGame,
  nextCommandId,
  playbackState,
  presence,
  revealState,
  roulettePool,
  scoredFinalState,
  send,
  startGame,
  startedGame,
  submissionState,
  validationError,
  videoId,
  votingState,
} from './fixtures';

describe('createInitialState', () => {
  it('builds a valid lobby with an injected seed and a full cycle', () => {
    const state = createInitialState({
      roomId: ROOM_ID,
      roomCode: 'ABCDEF',
      host: { id: id(1), connectionId: id(101), nickname: 'Host' },
      genrePool: roulettePool(),
      settings: makeSettings(),
      at: 0,
      rngSeed: 7,
    });
    expect(validationError(state)).toBeNull();
    expect(state.phase).toEqual({ type: 'LOBBY' });
    expect(state.round).toBeNull();
    expect(state.results).toEqual([]);
    expect(state.remainingGenreIds).toHaveLength(30);
    expect(state.rngState).toBe(7);
    expect(state.rouletteGenrePool).toHaveLength(30);
    expect(state.genrePool.map((genre) => genre.id)).toEqual(
      state.rouletteGenrePool.map((genre) => genre.id),
    );
    expect(state.players[id(1)]).toMatchObject({
      status: 'player',
      soundUnlocked: false,
      totalScore: 0,
    });
  });

  it('rejects an invalid injected seed instead of normalizing it', () => {
    const build = (rngSeed: number) => () =>
      createInitialState({
        roomId: ROOM_ID,
        roomCode: 'ABCDEF',
        host: { id: id(1), connectionId: id(101), nickname: 'Host' },
        genrePool: roulettePool(),
        settings: makeSettings(),
        at: 0,
        rngSeed,
      });
    expect(build(0)).toThrow(RangeError);
    expect(build(1.5)).toThrow(RangeError);
    expect(build(0x100000000)).toThrow(RangeError);
    expect(build(Number.NaN)).toThrow(RangeError);
    expect(build(0xffffffff)()).toBeDefined();
  });

  it('rejects a roulette catalogue below thirty genres', () => {
    expect(() =>
      createInitialState({
        roomId: ROOM_ID,
        roomCode: 'ABCDEF',
        host: { id: id(1), connectionId: id(101), nickname: 'Host' },
        genrePool: [genre(1)],
        settings: makeSettings(),
        at: 0,
        rngSeed: 7,
      }),
    ).toThrow();
  });
});

describe('joining and presence', () => {
  it('rejects duplicate nicknames case-insensitively and trimmed', () => {
    const lobby = newGame();
    const rejected = send(
      lobby,
      { type: 'JOIN', nickname: '  hOsT ' },
      { actorId: id(9), connectionId: id(109), at: 100 },
    );
    expect(rejected).toBe(lobby);
  });

  it('keeps nicknames reserved for departed records', () => {
    let state = newGame();
    state = command(state, id(2), { type: 'LEAVE' }, 100);
    const stolen = action(
      state,
      { type: 'JOIN', nickname: 'Player2' },
      { actorId: id(9), connectionId: id(109), at: 200 },
    );
    expect(classifyCommand(state, stolen)).toBe('NICKNAME_TAKEN');
    expect(reducer(state, stolen)).toBe(state);
  });

  it('caps the room at ten connected clients', () => {
    const full = newGame({ players: 10 });
    expect(validationError(full)).toBeNull();
    const overflow = action(
      full,
      { type: 'JOIN', nickname: 'Extra' },
      { actorId: id(90), connectionId: id(190), at: 100 },
    );
    expect(classifyCommand(full, overflow)).toBe('ROOM_FULL');
    expect(reducer(full, overflow)).toBe(full);
  });

  it('rebinds the latest tab and rejects the stale connection', () => {
    const state = startedGame();
    const rebound = send(
      state,
      { type: 'JOIN', nickname: 'Player2' },
      { actorId: id(2), connectionId: id(902), at: 1600 },
    );
    expect(rebound.players[id(2)].connectionId).toBe(id(902));
    expect(
      send(
        rebound,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(102), at: 1700 },
      ),
    ).toBe(rebound);
    expect(
      send(
        rebound,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(902), at: 1700 },
      ),
    ).not.toBe(rebound);
  });

  it('treats an unchanged join as a fresh no-op', () => {
    const state = newGame();
    const repeated = action(
      state,
      { type: 'JOIN', nickname: 'Player2' },
      { actorId: id(2), connectionId: id(102), at: 100 },
    );
    expect(classifyCommand(state, repeated)).toBe('NOT_READY');
    expect(reducer(state, repeated)).toBe(state);
    expect(state.appliedCommandIds).not.toContain(repeated.commandId);
  });

  it('keeps name, join time and score on reconnect', () => {
    let state = startedGame();
    state = {
      ...state,
      players: {
        ...state.players,
        [id(2)]: { ...state.players[id(2)], totalScore: 42 },
      },
    };
    state = command(state, id(2), { type: 'LEAVE' }, 1500);
    expect(state.players[id(2)].status).toBe('left');
    state = send(
      state,
      { type: 'JOIN', nickname: 'Someone else' },
      { actorId: id(2), connectionId: id(902), at: 1600 },
    );
    expect(state.players[id(2)]).toMatchObject({
      status: 'player',
      nickname: 'Player2',
      totalScore: 42,
      joinedAt: 0,
      connected: true,
      connectionId: id(902),
    });
  });

  it('treats a late join as spectator until the next round freezes participants', () => {
    let state = startedGame();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 1500 },
    );
    expect(state.players[id(9)].status).toBe('spectator');
    expect(state.round?.participantIds).not.toContain(id(9));
    state = hostAdvance(hostAdvance(hostAdvance(state, 2000), 2001), 2002);
    expect(state.phase.type).toBe('GENRE_SPIN');
    expect(state.round?.number).toBe(2);
    expect(state.players[id(9)].status).toBe('player');
    expect(state.round?.participantIds).toContain(id(9));
    expect(validationError(state)).toBeNull();
  });

  it('keeps roles and drafts across transient presence loss and recovers', () => {
    let state = submissionState();
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      4100,
    );
    const score = state.players[id(2)].totalScore;
    const lost = presence(state, 4200, [id(101), id(103), id(104)]);
    expect(lost.players[id(2)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    expect(lost.round?.submissions[id(2)].media.videoId).toBe(videoId(2));
    expect(lost.players[id(2)].totalScore).toBe(score);
    expect(validationError(lost)).toBeNull();
    const recovered = presence(lost, 4300, [
      id(101),
      id(102),
      id(103),
      id(104),
    ]);
    expect(recovered.players[id(2)]).toMatchObject({
      status: 'player',
      connected: true,
    });
    expect(recovered.round?.submissions[id(2)].media.videoId).toBe(videoId(2));
    expect(validationError(recovered)).toBeNull();
    const left = command(recovered, id(2), { type: 'LEAVE' }, 4400);
    expect(left.players[id(2)]).toMatchObject({
      status: 'left',
      connected: false,
    });
  });

  it('keeps a spectator role across transient presence loss', () => {
    let state = startedGame();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 1500 },
    );
    const lost = presence(state, 2000, [id(101), id(102), id(103), id(104)]);
    expect(lost.players[id(9)]).toMatchObject({
      status: 'spectator',
      connected: false,
    });
    const recovered = presence(lost, 2100, [
      id(101),
      id(102),
      id(103),
      id(104),
      id(109),
    ]);
    expect(recovered.players[id(9)]).toMatchObject({
      status: 'spectator',
      connected: true,
    });
    expect(recovered.round?.participantIds).not.toContain(id(9));
    expect(validationError(recovered)).toBeNull();
  });
});

describe('stale and replay protection', () => {
  it('rejects commands with a stale game or round number', () => {
    const state = startedGame();
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(102), at: 1500, gameNumber: 0 },
      ),
    ).toBe(state);
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(102), at: 1500, roundNumber: 0 },
      ),
    ).toBe(state);
  });

  it('ignores a replayed command id', () => {
    const state = startedGame();
    const commandId = nextCommandId();
    const applied = send(
      state,
      { type: 'SOUND_STATUS', unlocked: false },
      { actorId: id(2), connectionId: id(102), at: 1500, commandId },
    );
    expect(applied).not.toBe(state);
    expect(
      send(
        applied,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(102), at: 1600, commandId },
      ),
    ).toBe(applied);
  });

  it('keeps only the last 256 accepted command ids', () => {
    let state = newGame({ sound: false });
    const first = nextCommandId();
    state = send(
      state,
      { type: 'SOUND_STATUS', unlocked: true },
      { actorId: id(2), connectionId: id(102), at: 1, commandId: first },
    );
    for (let index = 1; index < 300; index += 1) {
      state = send(
        state,
        { type: 'SOUND_STATUS', unlocked: index % 2 === 1 },
        { actorId: id(2), connectionId: id(102), at: index },
      );
    }
    expect(state.appliedCommandIds).toHaveLength(256);
    expect(state.appliedCommandIds).not.toContain(first);
  });

  it('ignores commands from unknown players', () => {
    const state = startedGame();
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: true },
        { actorId: id(77), connectionId: id(177), at: 1500 },
      ),
    ).toBe(state);
  });

  it('returns the identical reference and classifies fresh no-ops as NOT_READY', () => {
    const state = startedGame();
    const noop = action(
      state,
      { type: 'SOUND_STATUS', unlocked: true },
      { actorId: id(2), connectionId: id(102), at: 1500 },
    );
    expect(classifyCommand(state, noop)).toBe('NOT_READY');
    expect(reducer(state, noop)).toBe(state);
    expect(state.appliedCommandIds).not.toContain(noop.commandId);
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(999), at: 1500 },
      ),
    ).toBe(state);
  });

  it('agrees on cached replays versus fresh no-ops', () => {
    const state = startedGame();
    const change = action(
      state,
      { type: 'SOUND_STATUS', unlocked: false },
      { actorId: id(2), connectionId: id(102), at: 1500 },
    );
    expect(classifyCommand(state, change)).toBeNull();
    const applied = reducer(state, change);
    expect(applied).not.toBe(state);
    expect(applied.appliedCommandIds).toContain(change.commandId);
    expect(classifyCommand(applied, change)).toBeNull();
    expect(reducer(applied, change)).toBe(applied);
  });
});

describe('classifyCommand', () => {
  it('reports protocol rejection reasons', () => {
    const lobby = newGame({ sound: false });
    expect(
      classifyCommand(
        lobby,
        action(
          lobby,
          { type: 'START_GAME' },
          { actorId: id(1), connectionId: id(101), at: 100 },
        ),
      ),
    ).toBe('NOT_READY');
    expect(
      classifyCommand(
        lobby,
        action(
          lobby,
          { type: 'START_GAME' },
          { actorId: id(2), connectionId: id(102), at: 100 },
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      classifyCommand(
        lobby,
        action(
          lobby,
          { type: 'JOIN', nickname: 'Host' },
          { actorId: id(9), connectionId: id(109), at: 100 },
        ),
      ),
    ).toBe('NICKNAME_TAKEN');
    expect(
      classifyCommand(
        lobby,
        action(
          lobby,
          { type: 'SOUND_STATUS', unlocked: true },
          { actorId: id(2), connectionId: id(102), at: 100, gameNumber: 5 },
        ),
      ),
    ).toBe('STALE');
    const started = startedGame();
    expect(
      classifyCommand(
        started,
        action(
          started,
          { type: 'SET_SETTINGS', settings: makeSettings() },
          { actorId: id(1), connectionId: id(101), at: 1500 },
        ),
      ),
    ).toBe('WRONG_PHASE');
    const kicked = command(
      submissionState(),
      id(1),
      { type: 'KICK', playerId: id(3) },
      5001,
    );
    expect(
      classifyCommand(
        kicked,
        action(
          kicked,
          { type: 'SOUND_STATUS', unlocked: true },
          { actorId: id(3), connectionId: id(103), at: 5002 },
        ),
      ),
    ).toBe('KICKED');
  });
});

describe('lobby settings', () => {
  it('lets only the host change settings and only in the lobby', () => {
    const lobby = newGame();
    const updated = command(
      lobby,
      lobby.hostId,
      { type: 'SET_SETTINGS', settings: makeSettings({ rounds: 3 }) },
      100,
    );
    expect(updated.settings.rounds).toBe(3);
    expect(validationError(updated)).toBeNull();
    expect(
      command(
        lobby,
        id(2),
        { type: 'SET_SETTINGS', settings: makeSettings({ rounds: 3 }) },
        100,
      ),
    ).toBe(lobby);
    const started = startedGame();
    expect(
      command(
        started,
        started.hostId,
        { type: 'SET_SETTINGS', settings: makeSettings({ rounds: 3 }) },
        1500,
      ),
    ).toBe(started);
  });

  it('recomputes the genre pool and cycle for custom and fixed modes', () => {
    const lobby = newGame();
    const custom = [genre(1), genre(2)];
    const customState = command(
      lobby,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'custom', items: custom } }),
      },
      100,
    );
    expect(customState.genrePool).toHaveLength(2);
    expect(customState.remainingGenreIds).toEqual(['g1', 'g2']);
    expect(validationError(customState)).toBeNull();
    const fixedGenre = genre(7);
    const fixedState = command(
      customState,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'fixed', genre: fixedGenre } }),
      },
      200,
    );
    expect(fixedState.genrePool).toEqual([fixedGenre]);
    expect(fixedState.remainingGenreIds).toEqual(['g7']);
    expect(validationError(fixedState)).toBeNull();
  });

  it('restores the injected catalogue when switching back to roulette', () => {
    const catalogue = roulettePool();
    const lobby = newGame({ genrePool: catalogue });
    const custom = [genre(1), genre(2)];
    let state = command(
      lobby,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'custom', items: custom } }),
      },
      100,
    );
    expect(state.genrePool).toHaveLength(2);
    const switchBack = action(
      state,
      { type: 'SET_SETTINGS', settings: makeSettings() },
      { actorId: lobby.hostId, connectionId: id(101), at: 200 },
    );
    expect(classifyCommand(state, switchBack)).toBeNull();
    state = reducer(state, switchBack);
    expect(state.settings.genre).toEqual({ mode: 'roulette' });
    expect(state.genrePool.map((entry) => entry.id)).toEqual(
      catalogue.map((entry) => entry.id),
    );
    expect(state.remainingGenreIds).toHaveLength(30);
    expect(validationError(state)).toBeNull();

    const fixedState = command(
      state,
      state.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'fixed', genre: genre(5) } }),
      },
      300,
    );
    expect(fixedState.genrePool).toHaveLength(1);
    const backToRoulette = action(
      fixedState,
      { type: 'SET_SETTINGS', settings: makeSettings() },
      { actorId: state.hostId, connectionId: id(101), at: 400 },
    );
    expect(classifyCommand(fixedState, backToRoulette)).toBeNull();
    const restored = reducer(fixedState, backToRoulette);
    expect(restored.genrePool).toHaveLength(30);
    expect(validationError(restored)).toBeNull();
  });

  it('is a no-op for identical settings', () => {
    const lobby = newGame();
    expect(
      command(
        lobby,
        lobby.hostId,
        { type: 'SET_SETTINGS', settings: lobby.settings },
        100,
      ),
    ).toBe(lobby);
  });

  it('applies custom list edits while preserving catalogue and seed', () => {
    const catalogue = roulettePool();
    const lobby = newGame({ genrePool: catalogue });
    const seed = lobby.rngState;
    const custom = command(
      lobby,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({
          genre: { mode: 'custom', items: [genre(2), genre(1)] },
        }),
      },
      100,
    );
    expect(custom.genrePool.map((entry) => entry.id)).toEqual(['g2', 'g1']);
    expect(custom.remainingGenreIds).toEqual(['g2', 'g1']);
    const identical = action(
      custom,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({
          genre: { mode: 'custom', items: [genre(2), genre(1)] },
        }),
      },
      { actorId: lobby.hostId, connectionId: id(101), at: 150 },
    );
    expect(classifyCommand(custom, identical)).toBe('NOT_READY');
    expect(reducer(custom, identical)).toBe(custom);
    const relabelled = [genre(2), { ...genre(1), de: 'Genre Eins' }];
    const edit = action(
      custom,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({
          genre: { mode: 'custom', items: relabelled },
        }),
      },
      { actorId: lobby.hostId, connectionId: id(101), at: 200 },
    );
    expect(classifyCommand(custom, edit)).toBeNull();
    const applied = reducer(custom, edit);
    expect(applied.settings.genre).toEqual({
      mode: 'custom',
      items: relabelled,
    });
    expect(applied.rouletteGenrePool).toEqual(catalogue);
    expect(applied.rngState).toBe(seed);
    expect(validationError(applied)).toBeNull();
    const longer = [genre(2), genre(1), genre(3)];
    const grown = command(
      applied,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'custom', items: longer } }),
      },
      300,
    );
    expect(grown.genrePool.map((entry) => entry.id)).toEqual([
      'g2',
      'g1',
      'g3',
    ]);
    expect(grown.remainingGenreIds).toHaveLength(3);
    expect(grown.rouletteGenrePool).toEqual(catalogue);
    expect(validationError(grown)).toBeNull();
  });

  it('applies fixed and roulette edits without dropping the catalogue', () => {
    const catalogue = roulettePool();
    const lobby = newGame({ genrePool: catalogue });
    const fixedState = command(
      lobby,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'fixed', genre: genre(4) } }),
      },
      100,
    );
    expect(fixedState.genrePool).toEqual([genre(4)]);
    expect(fixedState.remainingGenreIds).toEqual(['g4']);
    const identical = action(
      fixedState,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({
          genre: { mode: 'fixed', genre: { ...genre(4) } },
        }),
      },
      { actorId: lobby.hostId, connectionId: id(101), at: 200 },
    );
    expect(classifyCommand(fixedState, identical)).toBe('NOT_READY');
    expect(reducer(fixedState, identical)).toBe(fixedState);
    const relabelled = { ...genre(4), en: 'Genre Four' };
    const edit = action(
      fixedState,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'fixed', genre: relabelled } }),
      },
      { actorId: lobby.hostId, connectionId: id(101), at: 300 },
    );
    expect(classifyCommand(fixedState, edit)).toBeNull();
    const applied = reducer(fixedState, edit);
    expect(applied.settings.genre).toEqual({
      mode: 'fixed',
      genre: relabelled,
    });
    expect(applied.remainingGenreIds).toEqual(['g4']);
    expect(applied.rouletteGenrePool).toEqual(catalogue);
    const rouletteEdit = action(
      applied,
      { type: 'SET_SETTINGS', settings: makeSettings({ rounds: 4 }) },
      { actorId: lobby.hostId, connectionId: id(101), at: 400 },
    );
    expect(classifyCommand(applied, rouletteEdit)).toBeNull();
    const rouletteState = reducer(applied, rouletteEdit);
    expect(rouletteState.settings.rounds).toBe(4);
    expect(rouletteState.genrePool).toEqual(catalogue);
    expect(rouletteState.remainingGenreIds).toHaveLength(30);
    expect(validationError(rouletteState)).toBeNull();
  });
});

describe('starting a game', () => {
  it('requires three players, unlocked sound and the host', () => {
    const small = newGame({ players: 2 });
    expect(startGame(small, 1000)).toBe(small);
    const locked = newGame({ sound: false });
    expect(startGame(locked, 1000)).toBe(locked);
    const lobby = newGame();
    expect(command(lobby, id(2), { type: 'START_GAME' }, 1000)).toBe(lobby);
  });

  it('freezes participants and schedules the spin deadline', () => {
    const state = startedGame();
    expect(state.phase).toEqual({
      type: 'GENRE_SPIN',
      startedAt: 1000,
      deadlineAt: 4000,
    });
    expect(state.gameNumber).toBe(1);
    expect(state.round?.number).toBe(1);
    expect(state.round?.participantIds).toEqual([id(1), id(2), id(3), id(4)]);
    expect(state.remainingGenreIds).toHaveLength(29);
  });

  it('uses a one second intro for a fixed genre', () => {
    const fixed = genre(1);
    const state = startGame(
      newGame({
        settings: makeSettings({ genre: { mode: 'fixed', genre: fixed } }),
        genrePool: roulettePool(),
      }),
      1000,
    );
    expect(state.phase).toEqual({
      type: 'GENRE_SPIN',
      startedAt: 1000,
      deadlineAt: 2000,
    });
    expect(state.round?.genre).toEqual(fixed);
    expect(state.genrePool).toEqual([fixed]);
    expect(state.rouletteGenrePool).toHaveLength(30);
    expect(state.remainingGenreIds).toEqual(['g1']);
    expect(validationError(state)).toBeNull();
  });
});

describe('deadlines and host advance', () => {
  it('ignores an early deadline and fires at the boundary', () => {
    const state = startedGame();
    expect(reducer(state, { type: 'DEADLINE', at: 3999 })).toBe(state);
    const next = reducer(state, { type: 'DEADLINE', at: 4000 });
    expect(next.phase).toEqual({ type: 'SUBMISSION', deadlineAt: 94000 });
    expect(validationError(next)).toBeNull();
  });

  it('lets the host end a timed phase early', () => {
    expect(hostAdvance(startedGame(), 2500).phase).toEqual({
      type: 'SUBMISSION',
      deadlineAt: 92500,
    });
  });

  it('does not advance from the lobby or the final phase', () => {
    const lobby = newGame();
    expect(command(lobby, lobby.hostId, { type: 'ADVANCE' }, 100)).toBe(lobby);
    const ended = command(startedGame(), id(1), { type: 'END_GAME' }, 2000);
    expect(ended.phase).toEqual({ type: 'FINAL', reason: 'hostEnded' });
    expect(command(ended, id(1), { type: 'ADVANCE' }, 3000)).toBe(ended);
  });
});

describe('submission phase', () => {
  it('processes the due deadline and drops a command that arrives with it', () => {
    const submission = submissionState();
    const deadline =
      submission.phase.type === 'SUBMISSION' ? submission.phase.deadlineAt : 0;
    expect(deadline).toBe(94000);
    const lateAction = action(
      submission,
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      { actorId: id(1), connectionId: id(101), at: deadline },
    );
    expect(classifyCommand(submission, lateAction)).toBe('STALE');
    const late = reducer(submission, lateAction);
    expect(late.phase.type).toBe('REVEAL');
    expect(late.results[0].reason).toBe('noSongs');
    expect(late.round?.submissions).toEqual({});
    expect(validationError(late)).toBeNull();
    const early = command(
      submission,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      deadline - 1,
    );
    expect(early.round?.submissions[id(1)].media.videoId).toBe(videoId(1));
  });

  it('keeps the accepted order for an unchanged video id and copies payloads', () => {
    let state = submissionState();
    const payload = media(videoId(1));
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: payload },
      5000,
    );
    expect(state.round?.submissions[id(1)].acceptedOrder).toBe(0);
    expect(state.round?.submissions[id(1)].media).not.toBe(payload);
    expect(
      command(state, id(1), { type: 'SUBMIT_SONG', media: payload }, 5001),
    ).toBe(state);
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1), { startSeconds: 20 }) },
      5002,
    );
    expect(state.round?.submissions[id(1)].acceptedOrder).toBe(0);
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      5003,
    );
    expect(state.round?.submissions[id(1)].acceptedOrder).toBe(1);
    expect(state.round?.nextSubmissionOrder).toBe(2);
  });

  it('removes a submission before finishing but not after', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      5000,
    );
    state = command(state, id(1), { type: 'REMOVE_SUBMISSION' }, 5001);
    expect(state.round?.submissions[id(1)]).toBeUndefined();
    state = command(state, id(1), { type: 'FINISH_SUBMISSION' }, 5002);
    expect(
      command(
        state,
        id(1),
        { type: 'SUBMIT_SONG', media: media(videoId(3)) },
        5003,
      ),
    ).toBe(state);
  });

  it('rejects round actions from spectators', () => {
    let state = startedGame();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 1500 },
    );
    state = fireDeadline(state, 4000);
    expect(
      command(
        state,
        id(9),
        { type: 'SUBMIT_SONG', media: media(videoId(9)) },
        4100,
      ),
    ).toBe(state);
  });
});

describe('aggregation and playback', () => {
  it('merges linked submissions and clamps clip length', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      5000,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      5001,
    );
    state = command(
      state,
      id(3),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(6), { durationSeconds: 30, startSeconds: 20 }),
      },
      5002,
    );
    state = fireDeadline(state, 94000);
    expect(state.phase.type).toBe('PLAYBACK');
    const linked = state.round?.songs.find(
      (song) => song.media.videoId === videoId(5),
    );
    expect(linked?.ownerIds).toEqual([id(1), id(2)]);
    expect(linked?.clipSeconds).toBe(40);
    const clipped = state.round?.songs.find(
      (song) => song.media.videoId === videoId(6),
    );
    expect(clipped?.clipSeconds).toBe(10);
    expect(state.round?.playbackOrder).toHaveLength(2);
    expect(new Set(state.round?.playbackOrder).size).toBe(2);
    expect(validationError(state)).toBeNull();
  });

  it('counts the draft of a disconnected participant at the phase end', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      5000,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      5001,
    );
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(3)) },
      5002,
    );
    state = command(state, id(3), { type: 'LEAVE' }, 5003);
    expect(state.pause).toBeNull();
    state = command(state, id(1), { type: 'FINISH_SUBMISSION' }, 5004);
    state = command(state, id(2), { type: 'FINISH_SUBMISSION' }, 5005);
    state = command(state, id(4), { type: 'FINISH_SUBMISSION' }, 5006);
    expect(state.phase.type).toBe('PLAYBACK');
    expect(
      state.round?.songs.find((song) => song.media.videoId === videoId(3))
        ?.ownerIds,
    ).toEqual([id(3)]);
    expect(validationError(state)).toBeNull();
  });

  it('produces a deterministic shuffled playback order', () => {
    expect(playbackState().round?.playbackOrder).toEqual(
      playbackState().round?.playbackOrder,
    );
  });

  it('clamps playback to the clip and reaches voting', () => {
    let state = playbackState();
    const phase = state.phase;
    expect(phase).toEqual({
      type: 'PLAYBACK',
      index: 0,
      startAt: 7203,
      deadlineAt: 47203,
    });
    state = fireDeadline(state);
    expect(state.phase).toMatchObject({
      type: 'PLAYBACK',
      index: 1,
      startAt: 50203,
    });
    for (let step = 0; step < 5; step += 1) {
      if (state.phase.type !== 'PLAYBACK') {
        break;
      }
      state = fireDeadline(state);
    }
    expect(state.phase).toEqual({ type: 'VOTING', deadlineAt: 236203 });
    expect(validationError(state)).toBeNull();
  });

  it('quantizes playback deadlines to integer milliseconds near a video end', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(1), {
          durationSeconds: 100,
          startSeconds: 99.9995,
        }),
      },
      5000,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      5001,
    );
    state = fireDeadline(state, 94000);
    expect(state.round?.songs[0]?.clipSeconds).toBeCloseTo(0.0005, 10);
    for (let step = 0; step < 4; step += 1) {
      if (state.phase.type !== 'PLAYBACK') {
        break;
      }
      const phase = state.phase;
      expect(Number.isInteger(phase.startAt)).toBe(true);
      expect(Number.isInteger(phase.deadlineAt)).toBe(true);
      expect(phase.deadlineAt).toBeGreaterThanOrEqual(phase.startAt);
      expect(validationError(state)).toBeNull();
      state = fireDeadline(state);
    }
    expect(validationError(state)).toBeNull();
  });
});

describe('voting', () => {
  it('rejects own, linked and unknown rankings', () => {
    const state = votingState();
    const own = videoId(1);
    expect(
      command(state, id(1), { type: 'SET_RANKING', ranking: [own] }, 200000),
    ).toBe(state);
    expect(
      command(
        state,
        id(1),
        { type: 'SET_RANKING', ranking: [videoId(9)] },
        200000,
      ),
    ).toBe(state);
    const accepted = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      200000,
    );
    expect(accepted.round?.ballots[id(1)].ranking).toEqual([
      videoId(2),
      videoId(3),
      videoId(4),
    ]);
    expect(validationError(accepted)).toBeNull();
  });

  it('copies the ranking array instead of aliasing the caller', () => {
    const state = votingState();
    const ranking = [videoId(2), videoId(3), videoId(4)];
    const next = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking },
      200000,
    );
    expect(next.round?.ballots[id(1)].ranking).not.toBe(ranking);
    expect(next.round?.ballots[id(1)].ranking).toEqual(ranking);
  });

  it('allows a genre fail only once per player and song during playback', () => {
    const state = playbackState();
    expect(
      command(
        state,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(1), flagged: true },
        8000,
      ),
    ).toBe(state);
    const flagged = command(
      state,
      id(1),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      8001,
    );
    expect(flagged.round?.genreFailFlags[id(1)]).toEqual([videoId(2)]);
    expect(
      command(
        flagged,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
        8002,
      ),
    ).toBe(flagged);
    expect(
      command(
        flagged,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: false },
        8003,
      ),
    ).toBe(flagged);
  });

  it('retracts a genre fail during voting until voting is finished', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      200000,
    );
    expect(state.round?.genreFailFlags[id(1)]).toEqual([videoId(2)]);
    state = command(
      state,
      id(1),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: false },
      200001,
    );
    expect(state.round?.genreFailFlags[id(1)] ?? []).toEqual([]);
    state = command(state, id(1), { type: 'FINISH_VOTING' }, 200002);
    expect(
      command(
        state,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
        200003,
      ),
    ).toBe(state);
  });

  it('ends voting early when everyone is done', () => {
    let state = votingState();
    const participants = state.round?.participantIds ?? [];
    participants.forEach((playerId, index) => {
      state = command(
        state,
        playerId,
        { type: 'FINISH_VOTING' },
        200000 + index,
      );
    });
    expect(state.phase.type).toBe('REVEAL');
    expect(state.results[0].reason).toBe('normal');
    expect(validationError(state)).toBeNull();
  });
});

describe('scoring integration (AK-8)', () => {
  it('scores C 11, A 7, B 5, D 3 and reveals with per-song timing', () => {
    let state = votingState();
    const rankings: [string, string[]][] = [
      [id(1), [videoId(3), videoId(2), videoId(4)]],
      [id(2), [videoId(3), videoId(1), videoId(4)]],
      [id(3), [videoId(1), videoId(2), videoId(4)]],
      [id(4), [videoId(3), videoId(1), videoId(2)]],
    ];
    rankings.forEach(([playerId, ranking], index) => {
      state = command(
        state,
        playerId,
        { type: 'SET_RANKING', ranking },
        200000 + index,
      );
    });
    rankings.forEach(([playerId], index) => {
      state = command(
        state,
        playerId,
        { type: 'FINISH_VOTING' },
        201000 + index,
      );
    });
    expect(state.phase).toEqual({
      type: 'REVEAL',
      startedAt: 201003,
      deadlineAt: 201003 + 4 * 2500 + 5000,
    });
    expect(state.results[0].playerDeltas).toEqual({
      [id(1)]: 7,
      [id(2)]: 5,
      [id(3)]: 11,
      [id(4)]: 3,
    });
    expect(state.players[id(3)].totalScore).toBe(11);
    expect(
      state.results[0].songs.find(
        (scored) => scored.song.media.videoId === videoId(3),
      ),
    ).toMatchObject({ borda: 9, winner: true, bonus: 2 });
    expect(validationError(state)).toBeNull();
    const next = reducer(state, { type: 'DEADLINE', at: 240000 });
    expect(next.phase.type).toBe('GENRE_SPIN');
    expect(next.round?.number).toBe(2);
    expect(next.results).toHaveLength(1);
    expect(validationError(next)).toBeNull();
  });
});

describe('degenerate rounds', () => {
  it('reveals with zero points when nothing was submitted', () => {
    const state = fireDeadline(submissionState(), 94000);
    expect(state.phase).toEqual({
      type: 'REVEAL',
      startedAt: 94000,
      deadlineAt: 99000,
    });
    expect(state.results[0].reason).toBe('noSongs');
    expect(Object.values(state.results[0].playerDeltas)).toEqual([0, 0, 0, 0]);
    expect(state.players[id(1)].totalScore).toBe(0);
    expect(validationError(state)).toBeNull();
  });

  it('reveals with zero points for a single deduplicated song', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      5000,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      5001,
    );
    state = fireDeadline(state, 94000);
    expect(state.phase.type).toBe('REVEAL');
    const result = state.results[0];
    expect(result.reason).toBe('singleSong');
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].song.ownerIds).toEqual([id(1), id(2)]);
    expect(Object.values(result.playerDeltas)).toEqual([0, 0, 0, 0]);
    expect(result.songs[0].bonus).toBe(0);
    expect(validationError(state)).toBeNull();
  });

  it('draws each genre once before refilling the cycle', () => {
    const pool = [genre(1), genre(2)];
    let state = startGame(
      newGame({
        players: 3,
        genrePool: roulettePool(),
        settings: makeSettings({
          genre: { mode: 'custom', items: pool },
          rounds: 3,
        }),
      }),
      0,
    );
    expect(state.genrePool).toHaveLength(2);
    const draws = [state.round?.genre.id];
    state = hostAdvance(hostAdvance(hostAdvance(state, 1000), 1001), 1002);
    draws.push(state.round?.genre.id);
    state = hostAdvance(hostAdvance(hostAdvance(state, 2000), 2001), 2002);
    draws.push(state.round?.genre.id);
    state = hostAdvance(hostAdvance(hostAdvance(state, 3000), 3001), 3002);
    expect(draws[0]).not.toBe(draws[1]);
    expect(draws.slice(0, 2)).toContain(draws[2]);
    expect(state.phase).toEqual({ type: 'FINAL', reason: 'completed' });
    expect(state.results).toHaveLength(3);
    expect(state.round?.number).toBe(3);
    expect(validationError(state)).toBeNull();
  });
});

describe('pause and quorum', () => {
  it('pauses below three connected participants and shifts on resume', () => {
    let state = startedGame();
    state = command(state, id(2), { type: 'LEAVE' }, 1500);
    expect(state.pause).toBeNull();
    state = command(state, id(3), { type: 'LEAVE' }, 1600);
    expect(state.pause).toEqual({ at: 1600, reason: 'quorum' });
    expect(reducer(state, { type: 'DEADLINE', at: 999999 })).toBe(state);
    expect(
      command(state, id(1), { type: 'RESUME', forceBelowMinimum: false }, 2000),
    ).toBe(state);
    expect(command(state, id(2), { type: 'ADVANCE' }, 2001)).toBe(state);
    state = command(
      state,
      id(1),
      { type: 'RESUME', forceBelowMinimum: true },
      11600,
    );
    expect(state.pause).toBeNull();
    expect(state.forceBelowMinimum).toBe(true);
    expect(state.phase).toEqual({
      type: 'GENRE_SPIN',
      startedAt: 11000,
      deadlineAt: 14000,
    });
    expect(validationError(state)).toBeNull();
  });

  it('keeps the forced minimum guard until a further disconnect', () => {
    let state = startedGame();
    state = command(state, id(2), { type: 'LEAVE' }, 1500);
    state = command(state, id(3), { type: 'LEAVE' }, 1600);
    state = command(
      state,
      id(1),
      { type: 'RESUME', forceBelowMinimum: true },
      11600,
    );
    state = command(
      state,
      id(4),
      { type: 'SOUND_STATUS', unlocked: false },
      11700,
    );
    expect(state.forceBelowMinimum).toBe(true);
    expect(state.pause).toBeNull();
    state = command(state, id(4), { type: 'LEAVE' }, 11800);
    expect(state.forceBelowMinimum).toBe(false);
    expect(state.pause).toEqual({ at: 11800, reason: 'quorum' });
  });

  it('shifts playback start and deadline across a host pause', () => {
    let state = playbackState();
    const before = state.phase;
    state = command(state, id(1), { type: 'PAUSE' }, 10000);
    expect(state.pause).toEqual({ at: 10000, reason: 'host' });
    expect(reducer(state, { type: 'DEADLINE', at: 999999 })).toBe(state);
    state = command(
      state,
      id(1),
      { type: 'RESUME', forceBelowMinimum: false },
      20000,
    );
    expect(state.phase).toEqual({
      type: 'PLAYBACK',
      index: 0,
      startAt: 17203,
      deadlineAt: 57203,
    });
    expect(before.type).toBe('PLAYBACK');
    expect(validationError(state)).toBeNull();
  });

  it('does not count late-join spectators towards quorum', () => {
    let state = playbackState();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 8000 },
    );
    expect(state.players[id(9)].status).toBe('spectator');
    state = command(state, id(2), { type: 'LEAVE' }, 9000);
    state = command(state, id(3), { type: 'LEAVE' }, 9001);
    expect(state.pause).toEqual({ at: 9001, reason: 'quorum' });
  });
});

describe('host change', () => {
  const hostlessPresence = [id(102), id(103), id(104)];
  const fullPresence = [id(101), id(102), id(103), id(104)];

  function hostless(): GameState {
    const state = presence(startedGame(), 2000, hostlessPresence);
    expect(state.players[id(1)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    expect(electHost(state, hostlessPresence)).toBe(id(2));
    return state;
  }

  it('elects the oldest connected player and preserves the phase', () => {
    const state = hostless();
    const changed = reducer(state, {
      type: 'HOST_CHANGED',
      at: 2100,
      hostId: id(2),
      hostEpoch: 1,
      hostBaseVersion: state.stateVersion,
      connectionIds: hostlessPresence,
    });
    expect(changed).toMatchObject({
      hostId: id(2),
      hostEpoch: 1,
      hostBaseVersion: state.stateVersion,
      stateVersion: state.stateVersion + 1,
    });
    expect(changed.phase).toEqual(state.phase);
    expect(changed.round).toBe(state.round);
    expect(validationError(changed)).toBeNull();
  });

  it('elects a genuinely present snapshot-disconnected candidate without touching the base', () => {
    // Snapshot still flags the absent host connected, while the genuinely
    // present candidate id(2) is flagged disconnected. Migration must follow
    // the authoritative presence list and adopt the unmodified base.
    const state = presence(startedGame(), 2000, [id(101), id(103), id(104)]);
    expect(state.players[id(1)]).toMatchObject({
      status: 'player',
      connected: true,
    });
    expect(state.players[id(2)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    const present = [id(102), id(103), id(104)];
    expect(electHost(state, present)).toBe(id(2));
    const changed = reducer(state, {
      type: 'HOST_CHANGED',
      at: 2001,
      hostId: id(2),
      hostEpoch: 1,
      hostBaseVersion: state.stateVersion,
      connectionIds: present,
    });
    expect(changed).toMatchObject({
      hostId: id(2),
      hostEpoch: 1,
      hostBaseVersion: state.stateVersion,
      stateVersion: state.stateVersion + 1,
    });
    // Only the host lineage changes: the stale connected:true host record and
    // every other field stay byte-identical.
    expect(changed.players).toEqual(state.players);
    expect(changed.players[id(1)].connected).toBe(true);
    expect(changed.phase).toEqual(state.phase);
    expect(changed.round).toBe(state.round);
    expect(changed.results).toEqual(state.results);
    expect(changed.pause).toEqual(state.pause);
    expect(validationError(changed)).toBeNull();
  });

  it('no-ops on absent and duplicated presence candidates', () => {
    const state = presence(startedGame(), 2000, [id(101), id(103), id(104)]);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2001,
        hostId: id(1),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: [id(102), id(103), id(104)],
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2001,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: [id(103), id(104)],
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2001,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: [id(102), id(102)],
      }),
    ).toBe(state);
  });

  it('never elects a kicked or left candidate', () => {
    const base = startedGame();
    const kicked = command(
      base,
      id(1),
      { type: 'KICK', playerId: id(2) },
      2000,
    );
    expect(kicked.players[id(2)].status).toBe('kicked');
    expect(
      reducer(kicked, {
        type: 'HOST_CHANGED',
        at: 2001,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: kicked.stateVersion,
        connectionIds: fullPresence,
      }),
    ).toBe(kicked);
    const left = command(base, id(2), { type: 'LEAVE' }, 2000);
    expect(left.players[id(2)].status).toBe('left');
    expect(
      reducer(left, {
        type: 'HOST_CHANGED',
        at: 2001,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: left.stateVersion,
        connectionIds: fullPresence,
      }),
    ).toBe(left);
  });

  it('rejects a non-elected candidate, a stale epoch and a wrong base version', () => {
    const state = hostless();
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(3),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: hostlessPresence,
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(2),
        hostEpoch: 0,
        hostBaseVersion: state.stateVersion,
        connectionIds: hostlessPresence,
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(2),
        hostEpoch: 2,
        hostBaseVersion: state.stateVersion,
        connectionIds: hostlessPresence,
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion - 1,
        connectionIds: hostlessPresence,
      }),
    ).toBe(state);
  });

  it('preserves scores and deadlines when the host changes during voting', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      200000,
    );
    const phase = state.phase;
    const score = state.players[id(1)].totalScore;
    state = presence(state, 200100, hostlessPresence);
    const changed = reducer(state, {
      type: 'HOST_CHANGED',
      at: 200200,
      hostId: id(2),
      hostEpoch: 1,
      hostBaseVersion: state.stateVersion,
      connectionIds: hostlessPresence,
    });
    expect(changed.hostId).toBe(id(2));
    expect(changed.phase).toEqual(phase);
    expect(changed.players[id(1)].totalScore).toBe(score);
    expect(validationError(changed)).toBeNull();
  });
});

describe('departures and game end', () => {
  it('keeps a kicked submission and bans the client', () => {
    let state = submissionState();
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(3)) },
      5000,
    );
    state = command(state, id(1), { type: 'KICK', playerId: id(3) }, 5001);
    expect(state.players[id(3)]).toMatchObject({
      status: 'kicked',
      connected: false,
    });
    expect(state.round?.submissions[id(3)]).toBeDefined();
    expect(
      command(state, id(3), { type: 'JOIN', nickname: 'Player3' }, 5002),
    ).toBe(state);
    expect(validationError(state)).toBeNull();
  });

  it('ends a running game without scoring the unfinished round', () => {
    const state = command(startedGame(), id(1), { type: 'END_GAME' }, 2000);
    expect(state.phase).toEqual({ type: 'FINAL', reason: 'hostEnded' });
    expect(state.results).toHaveLength(0);
    expect(
      Object.values(state.players).every((player) => player.totalScore === 0),
    ).toBe(true);
    expect(validationError(state)).toBeNull();
  });

  it('clears the pause when the host ends a paused game', () => {
    let state = startedGame();
    state = command(state, id(2), { type: 'LEAVE' }, 1500);
    state = command(state, id(3), { type: 'LEAVE' }, 1600);
    expect(state.pause).not.toBeNull();
    state = command(state, id(1), { type: 'END_GAME' }, 1700);
    expect(state.phase).toEqual({ type: 'FINAL', reason: 'hostEnded' });
    expect(state.pause).toBeNull();
    expect(validationError(state)).toBeNull();
  });

  it('resets scores and results on rematch while keeping settings', () => {
    let state = command(startedGame(), id(1), { type: 'END_GAME' }, 2000);
    expect(command(state, id(1), { type: 'REMATCH' }, 2100).phase).toEqual({
      type: 'LOBBY',
    });
    state = command(state, id(1), { type: 'REMATCH' }, 2100);
    expect(state.round).toBeNull();
    expect(state.results).toEqual([]);
    expect(state.gameNumber).toBe(1);
    expect(state.appliedCommandIds).toEqual([]);
    expect(state.settings).toEqual(makeSettings());
    expect(
      Object.values(state.players).every((player) => player.totalScore === 0),
    ).toBe(true);
    expect(validationError(state)).toBeNull();
    expect(command(startedGame(), id(1), { type: 'REMATCH' }, 1500)).not.toBe(
      undefined,
    );
  });
});

describe('immutability', () => {
  it('never mutates the previous state', () => {
    const state = startedGame();
    const snapshot = structuredClone(state);
    const next = command(
      state,
      id(2),
      { type: 'SOUND_STATUS', unlocked: false },
      1500,
    );
    expect(next).not.toBe(state);
    expect(state).toEqual(snapshot);
  });
});

describe('final phase and rematch', () => {
  it('keeps settings, catalogue, game number and bans while clearing play state', () => {
    const state = scoredFinalState();
    expect(state.players[id(1)].totalScore).toBe(6);
    expect(state.players[id(2)].totalScore).toBe(3);
    expect(state.players[id(3)].totalScore).toBe(2);
    const kicked = command(
      state,
      id(1),
      { type: 'KICK', playerId: id(3) },
      175000,
    );
    expect(kicked.players[id(3)].status).toBe('kicked');
    const rematch = command(kicked, id(1), { type: 'REMATCH' }, 176000);
    expect(rematch.phase).toEqual({ type: 'LOBBY' });
    expect(rematch.round).toBeNull();
    expect(rematch.results).toEqual([]);
    expect(rematch.appliedCommandIds).toEqual([]);
    expect(rematch.pause).toBeNull();
    expect(rematch.forceBelowMinimum).toBe(false);
    expect(rematch.settings).toEqual(state.settings);
    expect(rematch.genrePool).toEqual(state.genrePool);
    expect(rematch.rouletteGenrePool).toEqual(state.rouletteGenrePool);
    expect(rematch.gameNumber).toBe(state.gameNumber);
    expect(rematch.hostId).toBe(state.hostId);
    expect(rematch.players[id(3)]).toMatchObject({
      status: 'kicked',
      nickname: 'Player3',
      totalScore: 0,
    });
    expect(
      Object.values(rematch.players).every((player) => player.totalScore === 0),
    ).toBe(true);
    expect(
      send(
        rematch,
        { type: 'JOIN', nickname: 'Player3' },
        { actorId: id(3), connectionId: id(103), at: 177000 },
      ),
    ).toBe(rematch);
    expect(validationError(rematch)).toBeNull();
  });

  it('never scores the same round twice on replay or migration', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      140000,
    );
    state = command(
      state,
      id(2),
      { type: 'SET_RANKING', ranking: [videoId(1), videoId(3), videoId(4)] },
      140001,
    );
    state = command(
      state,
      id(3),
      { type: 'SET_RANKING', ranking: [videoId(1), videoId(2), videoId(4)] },
      140002,
    );
    state = command(state, id(1), { type: 'FINISH_VOTING' }, 150000);
    state = command(state, id(2), { type: 'FINISH_VOTING' }, 150001);
    state = command(state, id(3), { type: 'FINISH_VOTING' }, 150002);
    const revealCommand = action(
      state,
      { type: 'FINISH_VOTING' },
      {
        actorId: id(4),
        connectionId: state.players[id(4)].connectionId,
        at: 150003,
      },
    );
    const revealed = reducer(state, revealCommand);
    expect(revealed.phase.type).toBe('REVEAL');
    expect(revealed.results).toHaveLength(1);
    const score = revealed.players[id(1)].totalScore;
    expect(score).toBe(8);
    expect(reducer(revealed, revealCommand)).toBe(revealed);
    const peers = Object.values(revealed.players)
      .filter((player) => player.connected && player.id !== revealed.hostId)
      .map((player) => player.connectionId);
    const synced = presence(revealed, 160000, peers);
    const candidate = electHost(synced, peers);
    expect(candidate).not.toBeNull();
    const migrated = reducer(synced, {
      type: 'HOST_CHANGED',
      at: 160001,
      hostId: candidate ?? '',
      hostEpoch: 1,
      hostBaseVersion: synced.stateVersion,
      connectionIds: peers,
    });
    expect(migrated.players[id(1)].totalScore).toBe(score);
    expect(migrated.results).toHaveLength(1);
    const next = reducer(migrated, { type: 'DEADLINE', at: 250000 });
    expect(next.phase.type).toBe('GENRE_SPIN');
    expect(next.results).toHaveLength(1);
    expect(next.players[id(1)].totalScore).toBe(score);
    expect(validationError(next)).toBeNull();
  });

  it('normalises departed records on rematch without touching the ban list', () => {
    let state = finalState();
    state = command(state, id(2), { type: 'LEAVE' }, 2100);
    expect(state.players[id(2)].status).toBe('left');
    const rematch = command(state, id(1), { type: 'REMATCH' }, 2200);
    expect(rematch.players[id(2)]).toMatchObject({
      status: 'left',
      connected: false,
      totalScore: 0,
    });
    expect(rematch.players[id(3)].status).toBe('player');
    expect(validationError(rematch)).toBeNull();
  });
});

describe('migration in every phase', () => {
  const phases: [string, () => GameState][] = [
    ['LOBBY', () => newGame()],
    ['GENRE_SPIN', () => startedGame()],
    ['SUBMISSION', () => submissionState()],
    ['PLAYBACK', () => playbackState()],
    ['VOTING', () => votingState()],
    ['REVEAL', () => revealState()],
    ['FINAL hostEnded', () => finalState()],
    ['FINAL completed', () => completedFinalState()],
  ];

  for (const [label, build] of phases) {
    it(`migrates the host during ${label} without drift`, () => {
      const state = build();
      const peers = Object.values(state.players)
        .filter((player) => player.connected && player.id !== state.hostId)
        .map((player) => player.connectionId);
      const synced = presence(state, 300000, peers);
      const candidate = electHost(synced, peers);
      expect(candidate).not.toBeNull();
      expect(candidate).not.toBe(state.hostId);
      const changed = reducer(synced, {
        type: 'HOST_CHANGED',
        at: 300001,
        hostId: candidate ?? '',
        hostEpoch: 1,
        hostBaseVersion: synced.stateVersion,
        connectionIds: peers,
      });
      expect(changed.hostId).toBe(candidate);
      expect(changed.hostEpoch).toBe(1);
      expect(changed.hostBaseVersion).toBe(synced.stateVersion);
      expect(changed.stateVersion).toBe(synced.stateVersion + 1);
      expect(changed.phase).toEqual(synced.phase);
      expect(changed.round).toEqual(synced.round);
      expect(changed.results).toEqual(synced.results);
      expect(changed.pause).toEqual(synced.pause);
      expect(changed.players).toEqual(synced.players);
      expect(validationError(changed)).toBeNull();
    });
  }
});

describe('pause cycles in every timed phase', () => {
  const phases: [string, () => GameState][] = [
    ['GENRE_SPIN', () => startedGame()],
    ['SUBMISSION', () => submissionState()],
    ['PLAYBACK', () => playbackState()],
    ['VOTING', () => votingState()],
    ['REVEAL', () => revealState()],
  ];

  for (const [label, build] of phases) {
    it(`freezes and shifts every timestamp during ${label}`, () => {
      const state = build();
      const deadline = 'deadlineAt' in state.phase ? state.phase.deadlineAt : 0;
      const at = deadline - 1;
      const paused = command(state, id(1), { type: 'PAUSE' }, at);
      expect(paused.pause).toEqual({ at, reason: 'host' });
      expect(paused.phase).toEqual(state.phase);
      expect(reducer(paused, { type: 'DEADLINE', at: deadline + 10 })).toBe(
        paused,
      );
      const resumed = command(
        paused,
        id(1),
        { type: 'RESUME', forceBelowMinimum: false },
        at + 5000,
      );
      expect(resumed.pause).toBeNull();
      expect(resumed.round).toEqual(paused.round);
      expect(resumed.players).toEqual(paused.players);
      expect(resumed.results).toEqual(paused.results);
      const shifted = resumed.phase;
      expect('deadlineAt' in shifted ? shifted.deadlineAt : null).toBe(
        deadline + 5000,
      );
      if (state.phase.type === 'GENRE_SPIN' && shifted.type === 'GENRE_SPIN') {
        expect(shifted.startedAt).toBe(state.phase.startedAt + 5000);
      }
      if (state.phase.type === 'SUBMISSION' && shifted.type === 'SUBMISSION') {
        expect(shifted.deadlineAt).toBe(state.phase.deadlineAt + 5000);
      }
      if (state.phase.type === 'PLAYBACK' && shifted.type === 'PLAYBACK') {
        expect(shifted.startAt).toBe(state.phase.startAt + 5000);
      }
      if (state.phase.type === 'VOTING' && shifted.type === 'VOTING') {
        expect(shifted.deadlineAt).toBe(state.phase.deadlineAt + 5000);
      }
      if (state.phase.type === 'REVEAL' && shifted.type === 'REVEAL') {
        expect(shifted.startedAt).toBe(state.phase.startedAt + 5000);
      }
      expect(validationError(resumed)).toBeNull();
    });
  }

  it('lets a due deadline win over a command that arrives with it', () => {
    const state = votingState();
    const deadline = state.phase.type === 'VOTING' ? state.phase.deadlineAt : 0;
    expect(deadline).toBe(236203);
    const late = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      deadline,
    );
    expect(late.phase.type).toBe('REVEAL');
    expect(late.round?.ballots[id(1)]).toBeUndefined();
    expect(late.results).toHaveLength(1);
    expect(validationError(late)).toBeNull();
    const inTime = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      deadline - 1,
    );
    expect(inTime.round?.ballots[id(1)].ranking).toHaveLength(3);
  });
});

describe('stale scope and input guards', () => {
  it('still rejects stale scopes after the command cache evicted an id', () => {
    let state = newGame({ sound: false });
    const evicted = nextCommandId();
    state = send(
      state,
      { type: 'SOUND_STATUS', unlocked: true },
      { actorId: id(2), connectionId: id(102), at: 1, commandId: evicted },
    );
    for (let index = 1; index < 300; index += 1) {
      state = send(
        state,
        { type: 'SOUND_STATUS', unlocked: index % 2 === 1 },
        { actorId: id(2), connectionId: id(102), at: index },
      );
    }
    expect(state.appliedCommandIds).not.toContain(evicted);
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: false },
        {
          actorId: id(2),
          connectionId: id(102),
          at: 400,
          roundNumber: 7,
        },
      ),
    ).toBe(state);
    expect(
      send(
        state,
        { type: 'SOUND_STATUS', unlocked: false },
        { actorId: id(2), connectionId: id(102), at: 400, gameNumber: 3 },
      ),
    ).toBe(state);
    expect(state.players[id(2)].soundUnlocked).toBe(true);
    const accepted = send(
      state,
      { type: 'SOUND_STATUS', unlocked: false },
      { actorId: id(2), connectionId: id(102), at: 400 },
    );
    expect(accepted).not.toBe(state);
    expect(validationError(accepted)).toBeNull();
  });

  it('ignores a presence sync with duplicate connections', () => {
    const state = startedGame();
    expect(
      reducer(state, {
        type: 'PRESENCE_SYNC',
        at: 2000,
        connectionIds: [id(102), id(102)],
      }),
    ).toBe(state);
  });

  it('rejects a blank nickname without touching the room', () => {
    const lobby = newGame();
    const rejected = send(
      lobby,
      { type: 'JOIN', nickname: '   ' },
      { actorId: id(9), connectionId: id(109), at: 100 },
    );
    expect(rejected).toBe(lobby);
    expect(
      Object.values(lobby.players).some((player) => player.id === id(9)),
    ).toBe(false);
  });
});

describe('connection binding and guard edges', () => {
  it('rejects a join that would hijack a bound connection', () => {
    const state = startedGame();
    const hijack = action(
      state,
      { type: 'JOIN', nickname: 'Impostor' },
      { actorId: id(9), connectionId: id(102), at: 1500 },
    );
    expect(classifyCommand(state, hijack)).toBe('FORBIDDEN');
    expect(reducer(state, hijack)).toBe(state);
  });

  it('protects the binding of a transiently disconnected identity', () => {
    const state = presence(startedGame(), 2000, [id(101), id(103), id(104)]);
    expect(state.players[id(2)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    expect(
      send(
        state,
        { type: 'JOIN', nickname: 'Impostor' },
        { actorId: id(9), connectionId: id(102), at: 2100 },
      ),
    ).toBe(state);
    expect(
      send(
        state,
        { type: 'JOIN', nickname: 'Player2' },
        { actorId: id(2), connectionId: id(102), at: 2200 },
      ),
    ).not.toBe(state);
  });

  it('rejects a rebind onto another player binding', () => {
    const state = startedGame();
    expect(
      send(
        state,
        { type: 'JOIN', nickname: 'Player2' },
        { actorId: id(2), connectionId: id(103), at: 1500 },
      ),
    ).toBe(state);
    expect(
      send(
        state,
        { type: 'JOIN', nickname: 'Player2' },
        { actorId: id(2), connectionId: id(902), at: 1600 },
      ),
    ).not.toBe(state);
  });

  it('rejects a self kick but kicks another player', () => {
    const state = startedGame();
    const selfKick = action(
      state,
      { type: 'KICK', playerId: id(1) },
      { actorId: id(1), connectionId: id(101), at: 1500 },
    );
    expect(classifyCommand(state, selfKick)).toBe('INVALID');
    expect(reducer(state, selfKick)).toBe(state);
    const other = command(
      state,
      id(1),
      { type: 'KICK', playerId: id(4) },
      1600,
    );
    expect(other.players[id(4)]).toMatchObject({
      status: 'kicked',
      connected: false,
    });
    expect(command(state, id(2), { type: 'KICK', playerId: id(4) }, 1600)).toBe(
      state,
    );
  });

  it('rejects fresh round commands while paused and accepts them after resume', () => {
    const paused = command(votingState(), id(1), { type: 'PAUSE' }, 200000);
    expect(paused.pause).toEqual({ at: 200000, reason: 'host' });
    const rankingWhilePaused = action(
      paused,
      { type: 'SET_RANKING', ranking: [videoId(1), videoId(3), videoId(4)] },
      { actorId: id(2), connectionId: id(102), at: 200001 },
    );
    expect(classifyCommand(paused, rankingWhilePaused)).toBe('WRONG_PHASE');
    expect(reducer(paused, rankingWhilePaused)).toBe(paused);
    expect(command(paused, id(2), { type: 'FINISH_VOTING' }, 200002)).toBe(
      paused,
    );
    const resumed = command(
      paused,
      id(1),
      { type: 'RESUME', forceBelowMinimum: false },
      205000,
    );
    expect(
      command(
        resumed,
        id(2),
        { type: 'SET_RANKING', ranking: [videoId(1), videoId(3), videoId(4)] },
        205001,
      ),
    ).not.toBe(resumed);
    const submissionPaused = command(
      submissionState(),
      id(1),
      { type: 'PAUSE' },
      4200,
    );
    const submitWhilePaused = action(
      submissionPaused,
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      { actorId: id(2), connectionId: id(102), at: 4201 },
    );
    expect(classifyCommand(submissionPaused, submitWhilePaused)).toBe(
      'WRONG_PHASE',
    );
    expect(reducer(submissionPaused, submitWhilePaused)).toBe(submissionPaused);
  });

  it('guards empty, duplicated and absent round inputs', () => {
    const state = votingState();
    const empty = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [] },
      200000,
    );
    expect(empty.round?.ballots[id(1)].ranking).toEqual([]);
    const duplicated = action(
      empty,
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(2)] },
      { actorId: id(1), connectionId: id(101), at: 200001 },
    );
    expect(classifyCommand(empty, duplicated)).toBe('INVALID');
    expect(reducer(empty, duplicated)).toBe(empty);
    expect(
      command(
        empty,
        id(1),
        { type: 'SET_RANKING', ranking: [videoId(9)] },
        200002,
      ),
    ).toBe(empty);
    expect(command(empty, id(1), { type: 'FINISH_VOTING' }, 200003)).not.toBe(
      empty,
    );
    expect(validationError(empty)).toBeNull();
    const submission = submissionState();
    const absentRemoval = action(
      submission,
      { type: 'REMOVE_SUBMISSION' },
      { actorId: id(1), connectionId: id(101), at: 4100 },
    );
    expect(classifyCommand(submission, absentRemoval)).toBe('INVALID');
    expect(reducer(submission, absentRemoval)).toBe(submission);
  });
});

describe('host election', () => {
  it('returns null when no candidate survives and host changes then noop', () => {
    let state = startedGame();
    state = presence(state, 2000, []);
    expect(electHost(state, [])).toBeNull();
    expect(state.pause).toEqual({ at: 2000, reason: 'quorum' });
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(2),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: [],
      }),
    ).toBe(state);
    expect(
      reducer(state, {
        type: 'HOST_CHANGED',
        at: 2100,
        hostId: id(1),
        hostEpoch: 1,
        hostBaseVersion: state.stateVersion,
        connectionIds: [],
      }),
    ).toBe(state);
    expect(state.hostId).toBe(id(1));
    expect(validationError(state)).toBeNull();
  });

  it('prefers participants over spectators and falls back to spectators', () => {
    let state = votingState();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 190000 },
    );
    expect(electHost(state, allConnections(state))).toBe(id(1));
    const spectatorOnly = presence(state, 195000, [id(109)]);
    expect(electHost(spectatorOnly, [id(109)])).toBe(id(9));
    expect(validationError(spectatorOnly)).toBeNull();
  });

  it('breaks equal join times by code-unit id order, not locale order', () => {
    const upperId = '00000000-0000-4000-8000-0000000000A0';
    const lowerId = '00000000-0000-4000-8000-0000000000a0';
    let state = newGame({ players: 1 });
    state = send(
      state,
      { type: 'JOIN', nickname: 'Upper' },
      { actorId: upperId, connectionId: id(501), at: 0 },
    );
    state = send(
      state,
      { type: 'JOIN', nickname: 'Lower' },
      { actorId: lowerId, connectionId: id(502), at: 0 },
    );
    const synced = presence(state, 100, [id(501), id(502)]);
    expect(electHost(synced, [id(501), id(502)])).toBe(upperId);
    expect(validationError(synced)).toBeNull();
  });
});

describe('submission order and completion', () => {
  it('lets the earliest remaining submission own the shared song', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5), { startSeconds: 10 }) },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(5), { startSeconds: 70 }) },
      4101,
    );
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(6)) },
      4102,
    );
    state = command(state, id(1), { type: 'REMOVE_SUBMISSION' }, 4103);
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5), { startSeconds: 40 }) },
      4104,
    );
    expect(state.round?.submissions[id(1)].acceptedOrder).toBe(3);
    state = fireDeadline(state, 94000);
    expect(state.phase.type).toBe('PLAYBACK');
    const shared = state.round?.songs.find(
      (song) => song.media.videoId === videoId(5),
    );
    expect(shared?.ownerIds).toEqual([id(2), id(1)]);
    expect(shared?.media.startSeconds).toBe(70);
    expect(shared?.clipSeconds).toBe(30);
    expect(validationError(state)).toBeNull();
  });

  it('drops a removed submission from the shared song entirely', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4101,
    );
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(6)) },
      4102,
    );
    state = command(state, id(1), { type: 'REMOVE_SUBMISSION' }, 4103);
    state = fireDeadline(state, 94000);
    expect(
      state.round?.songs.find((song) => song.media.videoId === videoId(5))
        ?.ownerIds,
    ).toEqual([id(2)]);
    expect(validationError(state)).toBeNull();
  });

  it('keeps the accepted order on a metadata edit of the same video', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(6)) },
      4101,
    );
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5), { startSeconds: 25 }) },
      4102,
    );
    expect(state.round?.submissions[id(1)].acceptedOrder).toBe(0);
    expect(state.round?.submissions[id(1)].media.startSeconds).toBe(25);
    expect(state.round?.nextSubmissionOrder).toBe(2);
  });

  it('allows finishing without a submission and keeps it irrevocable', () => {
    let state = submissionState();
    state = command(state, id(1), { type: 'FINISH_SUBMISSION' }, 4100);
    expect(state.round?.submissionDoneIds).toEqual([id(1)]);
    expect(state.round?.submissions[id(1)]).toBeUndefined();
    expect(
      command(
        state,
        id(1),
        { type: 'SUBMIT_SONG', media: media(videoId(1)) },
        4101,
      ),
    ).toBe(state);
    expect(command(state, id(1), { type: 'REMOVE_SUBMISSION' }, 4102)).toBe(
      state,
    );
    expect(command(state, id(1), { type: 'FINISH_SUBMISSION' }, 4103)).toBe(
      state,
    );
  });

  it('does not auto-finish voters that still have foreign songs', () => {
    const state = votingState();
    expect(state.round?.votingDoneIds).toEqual([]);
    for (const playerId of state.round?.participantIds ?? []) {
      const foreign =
        state.round?.songs.filter(
          (song) => !song.ownerIds.includes(playerId),
        ) ?? [];
      expect(foreign).toHaveLength(3);
    }
  });
});

describe('linked ownership', () => {
  it('forbids linked owners from ranking and flagging their shared song', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4101,
    );
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(6)) },
      4102,
    );
    state = fireDeadline(state, 94000);
    expect(state.phase.type).toBe('PLAYBACK');
    expect(
      command(
        state,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(5), flagged: true },
        95000,
      ),
    ).toBe(state);
    expect(
      command(
        state,
        id(2),
        { type: 'SET_GENRE_FAIL', videoId: videoId(5), flagged: true },
        95001,
      ),
    ).toBe(state);
    for (let step = 0; step < 4; step += 1) {
      if (state.phase.type !== 'PLAYBACK') {
        break;
      }
      state = fireDeadline(state);
    }
    expect(state.phase.type).toBe('VOTING');
    expect(
      command(
        state,
        id(1),
        { type: 'SET_RANKING', ranking: [videoId(5)] },
        200000,
      ),
    ).toBe(state);
    expect(
      command(
        state,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: videoId(5), flagged: true },
        200001,
      ),
    ).toBe(state);
    expect(
      command(
        state,
        id(1),
        { type: 'SET_RANKING', ranking: [videoId(6)] },
        200002,
      ),
    ).not.toBe(state);
    expect(validationError(state)).toBeNull();
  });
});

describe('frozen eligibility and departures', () => {
  it('freezes the genre-fail denominator and keeps departed votes and flags', () => {
    let state = votingState(5);
    state = command(
      state,
      id(2),
      {
        type: 'SET_RANKING',
        ranking: [videoId(1), videoId(3), videoId(4), videoId(5)],
      },
      220000,
    );
    state = command(
      state,
      id(3),
      {
        type: 'SET_RANKING',
        ranking: [videoId(1), videoId(2), videoId(4), videoId(5)],
      },
      220001,
    );
    state = command(
      state,
      id(4),
      {
        type: 'SET_RANKING',
        ranking: [videoId(1), videoId(2), videoId(3), videoId(5)],
      },
      220002,
    );
    state = command(
      state,
      id(2),
      { type: 'SET_GENRE_FAIL', videoId: videoId(1), flagged: true },
      220003,
    );
    state = command(
      state,
      id(3),
      { type: 'SET_GENRE_FAIL', videoId: videoId(1), flagged: true },
      220004,
    );
    state = command(
      state,
      id(4),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      220005,
    );
    state = command(state, id(4), { type: 'LEAVE' }, 229000);
    expect(state.round?.participantIds).toContain(id(4));
    expect(state.round?.ballots[id(4)].ranking).toHaveLength(4);
    expect(state.round?.genreFailFlags[id(4)]).toEqual([videoId(2)]);
    for (const playerId of [id(1), id(2), id(3), id(5)]) {
      state = command(state, playerId, { type: 'FINISH_VOTING' }, 230000);
    }
    expect(state.phase.type).toBe('REVEAL');
    expect(
      state.results[0].songs.find(
        (entry) => entry.song.media.videoId === videoId(1),
      ),
    ).toMatchObject({ genreFailed: false, flaggerIds: [id(2), id(3)] });
    expect(
      state.results[0].songs.find(
        (entry) => entry.song.media.videoId === videoId(2),
      )?.flaggerIds,
    ).toEqual([id(4)]);
    expect(validationError(state)).toBeNull();
  });

  it('keeps a kicked vote and flag and does not block the early end', () => {
    let state = votingState();
    state = command(
      state,
      id(3),
      { type: 'SET_RANKING', ranking: [videoId(1), videoId(2), videoId(4)] },
      200000,
    );
    state = command(
      state,
      id(3),
      { type: 'SET_GENRE_FAIL', videoId: videoId(1), flagged: true },
      200001,
    );
    state = command(state, id(1), { type: 'KICK', playerId: id(3) }, 200002);
    expect(state.players[id(3)].status).toBe('kicked');
    expect(state.round?.ballots[id(3)].ranking).toEqual([
      videoId(1),
      videoId(2),
      videoId(4),
    ]);
    for (const playerId of [id(1), id(2), id(4)]) {
      state = command(state, playerId, { type: 'FINISH_VOTING' }, 201000);
    }
    expect(state.phase.type).toBe('REVEAL');
    expect(
      state.results[0].songs.find(
        (entry) => entry.song.media.videoId === videoId(1),
      )?.flaggerIds,
    ).toEqual([id(3)]);
    expect(validationError(state)).toBeNull();
  });

  it('makes a rejoining participant immediately eligible again', () => {
    let state = submissionState();
    state = command(state, id(3), { type: 'LEAVE' }, 4100);
    expect(state.players[id(3)].status).toBe('left');
    expect(state.round?.participantIds).toContain(id(3));
    state = send(
      state,
      { type: 'JOIN', nickname: 'Player3' },
      { actorId: id(3), connectionId: id(903), at: 4200 },
    );
    expect(state.players[id(3)]).toMatchObject({
      status: 'player',
      connected: true,
      connectionId: id(903),
    });
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(3)) },
      4300,
    );
    expect(state.round?.submissions[id(3)].media.videoId).toBe(videoId(3));
    expect(validationError(state)).toBeNull();
  });

  it('keeps a late join out of the running round entirely', () => {
    let state = votingState();
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 190000 },
    );
    expect(state.players[id(9)].status).toBe('spectator');
    expect(state.round?.participantIds).not.toContain(id(9));
    expect(
      command(
        state,
        id(9),
        { type: 'SET_RANKING', ranking: [videoId(1)] },
        190100,
      ),
    ).toBe(state);
    expect(
      command(
        state,
        id(9),
        { type: 'SET_GENRE_FAIL', videoId: videoId(1), flagged: true },
        190200,
      ),
    ).toBe(state);
    expect(command(state, id(9), { type: 'FINISH_VOTING' }, 190300)).toBe(
      state,
    );
    expect(state.round?.votingDoneIds).not.toContain(id(9));
    expect(validationError(state)).toBeNull();
  });
});

describe('clip boundaries', () => {
  it('keeps the exact limit and fractional spans without exceeding them', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(1), { durationSeconds: 50, startSeconds: 10 }),
      },
      4100,
    );
    state = command(
      state,
      id(2),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(2), { durationSeconds: 100, startSeconds: 0 }),
      },
      4101,
    );
    state = command(
      state,
      id(3),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(3), {
          durationSeconds: 99.999,
          startSeconds: 60,
        }),
      },
      4102,
    );
    state = fireDeadline(state, 94000);
    expect(state.phase.type).toBe('PLAYBACK');
    const clips: Record<string, number> = {};
    for (const song of state.round?.songs ?? []) {
      clips[song.media.videoId] = song.clipSeconds;
    }
    expect(clips[videoId(1)]).toBe(40);
    expect(clips[videoId(2)]).toBe(40);
    expect(clips[videoId(3)]).toBeCloseTo(39.999, 10);
    for (let step = 0; step < 4; step += 1) {
      if (state.phase.type !== 'PLAYBACK') {
        break;
      }
      const phase = state.phase;
      expect(Number.isInteger(phase.startAt)).toBe(true);
      expect(Number.isInteger(phase.deadlineAt)).toBe(true);
      expect(phase.deadlineAt).toBeGreaterThanOrEqual(phase.startAt);
      expect(validationError(state)).toBeNull();
      state = fireDeadline(state);
    }
    expect(validationError(state)).toBeNull();
  });
});

describe('payload isolation', () => {
  it('stores copies of settings, pool and genre entries', () => {
    const lobby = newGame();
    const custom = [genre(1), genre(2)];
    const payload = makeSettings({
      genre: { mode: 'custom', items: custom },
    });
    const updated = command(
      lobby,
      lobby.hostId,
      { type: 'SET_SETTINGS', settings: payload },
      100,
    );
    payload.rounds = 9;
    custom[0].de = 'Mutated';
    custom.push(genre(3));
    expect(updated.settings.rounds).toBe(makeSettings().rounds);
    expect(updated.settings.genre).toEqual({
      mode: 'custom',
      items: [genre(1), genre(2)],
    });
    expect(updated.genrePool).toEqual([genre(1), genre(2)]);
    expect(validationError(updated)).toBeNull();
  });

  it('isolates stored media from later payload mutation', () => {
    const submission = submissionState();
    const payload = media(videoId(1));
    const state = command(
      submission,
      id(1),
      { type: 'SUBMIT_SONG', media: payload },
      4100,
    );
    payload.title = 'Mutated';
    payload.videoId = videoId(2);
    expect(state.round?.submissions[id(1)].media).toMatchObject({
      videoId: videoId(1),
      title: `Song ${videoId(1)}`,
    });
  });

  it('isolates the stored ranking from later array mutation', () => {
    const voting = votingState();
    const ranking = [videoId(2), videoId(3), videoId(4)];
    const state = command(
      voting,
      id(1),
      { type: 'SET_RANKING', ranking },
      200000,
    );
    ranking[0] = videoId(4);
    ranking.push(videoId(1));
    expect(state.round?.ballots[id(1)].ranking).toEqual([
      videoId(2),
      videoId(3),
      videoId(4),
    ]);
  });
});

describe('capacity policy', () => {
  it('refuses to reactivate a retained identity while ten clients are active', () => {
    let state = newGame({ players: 10 });
    expect(activeCount(state)).toBe(10);
    const withoutTwo = allConnections(state).filter(
      (connectionId) => connectionId !== state.players[id(2)].connectionId,
    );
    state = presence(state, 1000, withoutTwo);
    expect(state.players[id(2)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    expect(activeCount(state)).toBe(9);
    state = send(
      state,
      { type: 'JOIN', nickname: 'Eleventh' },
      { actorId: id(11), connectionId: id(111), at: 1100 },
    );
    expect(activeCount(state)).toBe(10);
    const overflow = action(
      state,
      { type: 'JOIN', nickname: 'Player2' },
      { actorId: id(2), connectionId: id(102), at: 1200 },
    );
    expect(classifyCommand(state, overflow)).toBe('ROOM_FULL');
    expect(reducer(state, overflow)).toBe(state);
    expect(activeCount(state)).toBe(10);
    expect(validationError(state)).toBeNull();
  });

  it('bounds presence recovery to ten active clients deterministically', () => {
    let state = newGame({ players: 10 });
    const dropped = [id(2), id(3), id(4)];
    state = presence(
      state,
      1000,
      Object.values(state.players)
        .filter((player) => !dropped.includes(player.id))
        .map((player) => player.connectionId),
    );
    expect(activeCount(state)).toBe(7);
    for (let index = 0; index < 3; index += 1) {
      state = send(
        state,
        { type: 'JOIN', nickname: `Later${11 + index}` },
        {
          actorId: id(11 + index),
          connectionId: id(111 + index),
          at: 1100 + index,
        },
      );
    }
    expect(activeCount(state)).toBe(10);
    expect(Object.keys(state.players)).toHaveLength(13);
    // Every socket is back, but only ten may be active at once.
    const full = presence(state, 1200, allConnections(state));
    expect(activeCount(full)).toBe(10);
    expect(full.players[id(2)]).toMatchObject({
      status: 'player',
      connected: false,
    });
    expect(full.players[id(3)].connected).toBe(false);
    expect(full.players[id(4)].connected).toBe(false);
    expect(validationError(full)).toBeNull();
    // Two slots free: recovery follows join order, not record order.
    const twoFreed = allConnections(full).filter(
      (connectionId) =>
        connectionId !== full.players[id(5)].connectionId &&
        connectionId !== full.players[id(6)].connectionId,
    );
    const recovered = presence(full, 1300, twoFreed);
    expect(activeCount(recovered)).toBe(10);
    expect(recovered.players[id(2)].connected).toBe(true);
    expect(recovered.players[id(3)].connected).toBe(true);
    expect(recovered.players[id(4)]).toMatchObject({
      status: 'player',
      connected: false,
      totalScore: 0,
    });
    expect(recovered.players[id(5)].connected).toBe(false);
    expect(recovered.players[id(6)].connected).toBe(false);
    expect(validationError(recovered)).toBeNull();
  });

  it('rebinds an active client at full capacity without consuming a slot', () => {
    const state = newGame({ players: 10 });
    expect(activeCount(state)).toBe(10);
    const rebind = action(
      state,
      { type: 'JOIN', nickname: 'Host' },
      { actorId: id(1), connectionId: id(901), at: 1000 },
    );
    expect(classifyCommand(state, rebind)).toBeNull();
    const rebound = reducer(state, rebind);
    expect(rebound.players[id(1)]).toMatchObject({
      connectionId: id(901),
      connected: true,
      totalScore: 0,
    });
    expect(activeCount(rebound)).toBe(10);
    expect(validationError(rebound)).toBeNull();
  });

  it('re-admits a retained identity once a slot frees', () => {
    let state = newGame({ players: 10 });
    const withoutTwo = allConnections(state).filter(
      (connectionId) => connectionId !== state.players[id(2)].connectionId,
    );
    state = presence(state, 1000, withoutTwo);
    state = send(
      state,
      { type: 'JOIN', nickname: 'Eleventh' },
      { actorId: id(11), connectionId: id(111), at: 1100 },
    );
    const blocked = action(
      state,
      { type: 'JOIN', nickname: 'Player2' },
      { actorId: id(2), connectionId: id(102), at: 1200 },
    );
    expect(classifyCommand(state, blocked)).toBe('ROOM_FULL');
    // Freeing a slot admits the retained identity again, keeping its record.
    const freed = presence(
      state,
      1300,
      allConnections(state).filter(
        (connectionId) =>
          connectionId !== state.players[id(11)].connectionId &&
          connectionId !== state.players[id(2)].connectionId,
      ),
    );
    expect(activeCount(freed)).toBe(9);
    expect(freed.players[id(2)].connected).toBe(false);
    const admitted = command(
      freed,
      id(2),
      { type: 'JOIN', nickname: 'Player2' },
      1400,
    );
    expect(admitted.players[id(2)]).toMatchObject({
      connected: true,
      status: 'player',
      totalScore: 0,
      nickname: 'Player2',
    });
    expect(activeCount(admitted)).toBe(10);
    expect(validationError(admitted)).toBeNull();
  });

  it('never revives departed identities through presence', () => {
    const base = newGame({ players: 4 });
    const left = command(base, id(2), { type: 'LEAVE' }, 1000);
    expect(left.players[id(2)]).toMatchObject({
      status: 'left',
      connected: false,
    });
    expect(presence(left, 1100, allConnections(left))).toBe(left);
    const kicked = command(
      base,
      id(1),
      { type: 'KICK', playerId: id(3) },
      1000,
    );
    expect(kicked.players[id(3)]).toMatchObject({
      status: 'kicked',
      connected: false,
    });
    expect(presence(kicked, 1100, allConnections(kicked))).toBe(kicked);
  });
});
