import { GameStateSchema, type GameState, type Player } from '../shared/game';
import type { Genre } from '../shared/primitives';
import type { Settings } from '../shared/settings';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const MAX_APPLIED_COMMANDS = 256;

export interface HostSeed {
  id: string;
  connectionId: string;
  nickname: string;
}

export interface CreateInitialStateArgs {
  roomId: string;
  roomCode: string;
  host: HostSeed;
  /** Injected roulette catalogue (30-50 genres), always retained in the state. */
  genrePool: Genre[];
  settings: Settings;
  at: number;
  rngSeed: number;
}

export function isActivePlayer(player: Player): boolean {
  return (
    player.connected && player.status !== 'left' && player.status !== 'kicked'
  );
}

export function activePlayers(players: Record<string, Player>): Player[] {
  return Object.values(players).filter(isActivePlayer);
}

/** Stable activity order: oldest join first, clientId breaks ties. */
export function sortPlayers(players: readonly Player[]): Player[] {
  return [...players].sort(
    (a, b) =>
      a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Active pool for the selected mode. The injected catalogue is only the source
 * for roulette; custom and fixed derive their pool from the settings (FR-11).
 */
export function genrePoolForSettings(
  settings: Settings,
  catalogue: readonly Genre[],
): Genre[] {
  switch (settings.genre.mode) {
    case 'custom':
      return settings.genre.items.map((genre) => ({ ...genre }));
    case 'fixed':
      return [{ ...settings.genre.genre }];
    case 'roulette':
      return catalogue.map((genre) => ({ ...genre }));
  }
}

export function initialRemainingGenreIds(
  settings: Settings,
  pool: readonly Genre[],
): string[] {
  return settings.genre.mode === 'fixed'
    ? [settings.genre.genre.id]
    : pool.map((genre) => genre.id);
}

/** Bounded FIFO of accepted command ids for replay suppression. */
export function rememberCommand(
  ids: readonly string[],
  commandId: string,
): string[] {
  const next = [...ids, commandId];
  return next.length > MAX_APPLIED_COMMANDS
    ? next.slice(next.length - MAX_APPLIED_COMMANDS)
    : next;
}

/** Copies the player map only once a non-zero delta actually lands. */
export function applyDeltas(
  players: Record<string, Player>,
  deltas: Record<string, number>,
): Record<string, Player> {
  let next = players;
  for (const [id, delta] of Object.entries(deltas)) {
    const player = players[id];
    if (delta === 0 || !player) {
      continue;
    }
    if (next === players) {
      next = { ...players };
    }
    next[id] = { ...player, totalScore: player.totalScore + delta };
  }
  return next;
}

export function createInitialState(args: CreateInitialStateArgs): GameState {
  const { roomId, roomCode, host, genrePool, settings, at, rngSeed } = args;
  if (!Number.isInteger(rngSeed) || rngSeed < 1 || rngSeed > 0xffffffff) {
    throw new RangeError('rngSeed must be an integer within 1..0xffffffff');
  }
  const pool = genrePoolForSettings(settings, genrePool);
  const state: GameState = {
    roomId,
    roomCode,
    stateVersion: 0,
    gameNumber: 0,
    hostId: host.id,
    hostEpoch: 0,
    hostBaseVersion: 0,
    settings,
    players: {
      [host.id]: {
        id: host.id,
        connectionId: host.connectionId,
        nickname: host.nickname,
        joinedAt: at,
        status: 'player',
        connected: true,
        soundUnlocked: false,
        totalScore: 0,
      },
    },
    genrePool: pool,
    rouletteGenrePool: genrePool.map((genre) => ({ ...genre })),
    remainingGenreIds: initialRemainingGenreIds(settings, pool),
    rngState: rngSeed,
    phase: { type: 'LOBBY' },
    round: null,
    results: [],
    pause: null,
    forceBelowMinimum: false,
    appliedCommandIds: [],
  };
  return GameStateSchema.parse(state);
}
