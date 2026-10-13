import { expect } from 'vitest';
import type { ClientAction, EngineAction } from '../shared/actions';
import { GameStateSchema, type GameState } from '../shared/game';
import type { Genre, Media } from '../shared/primitives';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { reducer } from './reducer';
import { activePlayers, createInitialState, isActivePlayer } from './state';

/**
 * Test-only builders. Never imported by the app or the engine itself; it is
 * excluded from the coverage threshold.
 */

export const ROOM_ID = '10000000-0000-4000-8000-000000000000';

export function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

export function videoId(index: number): string {
  return `v${index.toString().padStart(10, '0')}`;
}

export function genre(index: number): Genre {
  return { id: `g${index}`, de: `Genre ${index}`, en: `Genre ${index}` };
}

/** Injected roulette catalogue: thirty unique genres. */
export function roulettePool(size = 30): Genre[] {
  return Array.from({ length: size }, (_, index) => genre(index));
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function media(video: string, overrides: Partial<Media> = {}): Media {
  return {
    videoId: video,
    title: `Song ${video}`,
    channel: 'Artist',
    thumbnail: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`,
    durationSeconds: 100,
    startSeconds: 10,
    ...overrides,
  };
}

let commandCounter = 0;

export function nextCommandId(): string {
  commandCounter += 1;
  return id(900000 + commandCounter);
}

export interface CommandOptions {
  actorId: string;
  connectionId: string;
  at: number;
  gameNumber?: number;
  roundNumber?: number;
  commandId?: string;
}

export type CommandEvent = Extract<EngineAction, { type: 'COMMAND' }>;

export function action(
  state: GameState,
  command: ClientAction,
  options: CommandOptions,
): CommandEvent {
  return {
    type: 'COMMAND',
    actorId: options.actorId,
    connectionId: options.connectionId,
    commandId: options.commandId ?? nextCommandId(),
    at: options.at,
    gameNumber: options.gameNumber ?? state.gameNumber,
    roundNumber: options.roundNumber ?? (state.round ? state.round.number : 0),
    command,
  };
}

export function send(
  state: GameState,
  command: ClientAction,
  options: CommandOptions,
): GameState {
  return reducer(state, action(state, command, options));
}

/** Command from the connection currently bound to the player. */
export function command(
  state: GameState,
  playerId: string,
  client: ClientAction,
  at: number,
): GameState {
  return send(state, client, {
    actorId: playerId,
    connectionId: state.players[playerId].connectionId,
    at,
  });
}

export interface GameOptions {
  players?: number;
  settings?: Settings;
  genrePool?: Genre[];
  rngSeed?: number;
  at?: number;
  sound?: boolean;
}

export function newGame(options: GameOptions = {}): GameState {
  let state = createInitialState({
    roomId: ROOM_ID,
    roomCode: 'ABCDEF',
    host: { id: id(1), connectionId: id(101), nickname: 'Host' },
    genrePool: options.genrePool ?? roulettePool(),
    settings: options.settings ?? makeSettings(),
    at: options.at ?? 0,
    rngSeed: options.rngSeed ?? 12345,
  });
  const count = options.players ?? 4;
  for (let index = 2; index <= count; index += 1) {
    state = send(
      state,
      { type: 'JOIN', nickname: `Player${index}` },
      { actorId: id(index), connectionId: id(100 + index), at: 0 },
    );
  }
  if (options.sound ?? true) {
    for (const player of activePlayers(state.players)) {
      state = command(
        state,
        player.id,
        { type: 'SOUND_STATUS', unlocked: true },
        0,
      );
    }
  }
  return state;
}

export function startGame(state: GameState, at = 1000): GameState {
  return command(state, state.hostId, { type: 'START_GAME' }, at);
}

export function fireDeadline(state: GameState, at?: number): GameState {
  const phase = state.phase;
  const target = at ?? ('deadlineAt' in phase ? phase.deadlineAt : 0);
  return reducer(state, { type: 'DEADLINE', at: target });
}

export function hostAdvance(state: GameState, at: number): GameState {
  return command(state, state.hostId, { type: 'ADVANCE' }, at);
}

export function presence(
  state: GameState,
  at: number,
  connectionIds: string[],
): GameState {
  return reducer(state, { type: 'PRESENCE_SYNC', at, connectionIds });
}

export function validationError(state: GameState): string | null {
  const result = GameStateSchema.safeParse(state);
  if (result.success) {
    return null;
  }
  return result.error.issues.map((issue) => issue.message).join('; ');
}

/** Players the capacity rule counts: connected and not left or kicked. */
export function activeCount(state: GameState): number {
  return Object.values(state.players).filter(isActivePlayer).length;
}

/** Connections of every retained record, in deterministic id order. */
export function allConnections(state: GameState): string[] {
  return Object.values(state.players).map((player) => player.connectionId);
}

export function startedGame(count = 4, settings?: Settings): GameState {
  const state = startGame(newGame({ players: count, settings }), 1000);
  expect(validationError(state)).toBeNull();
  return state;
}

export function submissionState(count = 4, settings?: Settings): GameState {
  const state = fireDeadline(startedGame(count, settings), 4000);
  expect(state.phase.type).toBe('SUBMISSION');
  return state;
}

export function playbackState(count = 4, settings?: Settings): GameState {
  let state = submissionState(count, settings);
  state.round?.participantIds.forEach((playerId, index) => {
    state = command(
      state,
      playerId,
      { type: 'SUBMIT_SONG', media: media(videoId(index + 1)) },
      4100 + index,
    );
    state = command(
      state,
      playerId,
      { type: 'FINISH_SUBMISSION' },
      4200 + index,
    );
  });
  expect(state.phase.type).toBe('PLAYBACK');
  expect(validationError(state)).toBeNull();
  return state;
}

export function votingState(count = 4, settings?: Settings): GameState {
  let state = playbackState(count, settings);
  for (let step = 0; step < 8 && state.phase.type === 'PLAYBACK'; step += 1) {
    state = fireDeadline(state);
  }
  expect(state.phase.type).toBe('VOTING');
  expect(validationError(state)).toBeNull();
  return state;
}

/** Round with no submissions, already revealed as a noSongs result. */
export function revealState(count = 4, settings?: Settings): GameState {
  const state = fireDeadline(submissionState(count, settings), 94000);
  expect(state.phase.type).toBe('REVEAL');
  expect(validationError(state)).toBeNull();
  return state;
}

export function finalState(count = 4): GameState {
  const state = command(startedGame(count), id(1), { type: 'END_GAME' }, 2000);
  expect(state.phase).toEqual({ type: 'FINAL', reason: 'hostEnded' });
  expect(validationError(state)).toBeNull();
  return state;
}

export function completedFinalState(count = 4): GameState {
  const state = startGame(
    newGame({ players: count, settings: makeSettings({ rounds: 1 }) }),
    1000,
  );
  const advanced = hostAdvance(
    hostAdvance(hostAdvance(state, 2000), 2001),
    2002,
  );
  expect(advanced.phase).toEqual({ type: 'FINAL', reason: 'completed' });
  expect(validationError(advanced)).toBeNull();
  return advanced;
}

/**
 * Three-player round with real, non-zero scores, completed as FINAL:
 * A 6, B 3, C 2 (song A wins with Borda 4 plus the +2 bonus).
 */
export function scoredFinalState(): GameState {
  let state = fireDeadline(
    startGame(
      newGame({ players: 3, settings: makeSettings({ rounds: 1 }) }),
      1000,
    ),
    4000,
  );
  state = command(
    state,
    id(1),
    { type: 'SUBMIT_SONG', media: media(videoId(1)) },
    4100,
  );
  state = command(
    state,
    id(2),
    { type: 'SUBMIT_SONG', media: media(videoId(2)) },
    4101,
  );
  state = command(
    state,
    id(3),
    { type: 'SUBMIT_SONG', media: media(videoId(3)) },
    4102,
  );
  for (let player = 1; player <= 3; player += 1) {
    state = command(
      state,
      id(player),
      { type: 'FINISH_SUBMISSION' },
      4200 + player,
    );
  }
  for (let step = 0; step < 6; step += 1) {
    if (state.phase.type !== 'PLAYBACK') {
      break;
    }
    state = fireDeadline(state);
  }
  if (state.phase.type !== 'VOTING')
    throw new Error('Scored fixture did not reach voting');
  const voteAt =
    state.phase.deadlineAt - state.settings.votingSeconds * 1000 + 1;
  state = command(
    state,
    id(1),
    { type: 'SET_RANKING', ranking: [videoId(2), videoId(3)] },
    voteAt,
  );
  state = command(
    state,
    id(2),
    { type: 'SET_RANKING', ranking: [videoId(1), videoId(3)] },
    voteAt + 1,
  );
  state = command(
    state,
    id(3),
    { type: 'SET_RANKING', ranking: [videoId(1), videoId(2)] },
    voteAt + 2,
  );
  state = command(state, id(1), { type: 'FINISH_VOTING' }, voteAt + 3);
  state = command(state, id(2), { type: 'FINISH_VOTING' }, voteAt + 4);
  state = command(state, id(3), { type: 'FINISH_VOTING' }, voteAt + 5);
  const final = fireDeadline(state);
  expect(final.phase).toEqual({ type: 'FINAL', reason: 'completed' });
  expect(validationError(final)).toBeNull();
  return final;
}
