import type { z } from 'zod';
import type { EngineAction } from '../shared/actions';
import type {
  GameState,
  Phase,
  Player,
  Round,
  RoundResult,
  Song,
} from '../shared/game';
import { nicknameKey } from '../shared/primitives';
import type { RejectionSchema } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { drawGenre, shuffle } from './rng';
import { MAX_RATING, scoreRound } from './scoring';
import { groupSameSongs } from './songMatch';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  activePlayers,
  applyDeltas,
  genrePoolForSettings,
  initialRemainingGenreIds,
  isActivePlayer,
  rememberCommand,
  sortPlayers,
} from './state';

/**
 * Genre phase: the reel spins about 3200 ms with deceleration (`REEL_SPIN_MS`
 * in `src/ui/reel.ts`), then the result is held for at least 2000 ms.
 */
export const SPIN_MS = 5500;
export const FIXED_INTRO_MS = 1000;
export const PRE_ROLL_MS = 3000;
export const REVEAL_PER_SONG_MS = 2500;
/** Longer reveal slot for a banger entry (every rating a 10). */
export const BANGER_REVEAL_MS = 5000;
export const REVEAL_HOLD_MS = 5000;

export type CommandRejection = z.infer<typeof RejectionSchema>;

type CommandAction = Extract<EngineAction, { type: 'COMMAND' }>;
type DeadlineAction = Extract<EngineAction, { type: 'DEADLINE' }>;
type PresenceAction = Extract<EngineAction, { type: 'PRESENCE_SYNC' }>;
type HostChangedAction = Extract<EngineAction, { type: 'HOST_CHANGED' }>;

/**
 * Skip quorum (FR-43): ceil(0.9 n) in integer math, 1..10 -> 1,2,3,4,5,6,7,8,9,9.
 */
export function skipThreshold(activeCount: number): number {
  return Math.ceil((activeCount * 9) / 10);
}

export function reducer(state: GameState, action: EngineAction): GameState {
  switch (action.type) {
    case 'COMMAND':
      return skipAfter(state, reduceCommand(state, action), action.at);
    case 'DEADLINE':
      return reduceDeadline(state, action);
    case 'PRESENCE_SYNC':
      return skipAfter(state, reducePresenceSync(state, action), action.at);
    case 'HOST_CHANGED':
      return reduceHostChanged(state, action);
    default:
      return state;
  }
}

/**
 * Pure rejection classifier: `null` means the command would be applied (or is
 * an accepted no-op). Adapters use this so rejection reasons never duplicate
 * engine guards. A late command reports `STALE`: the reducer processes the due
 * deadline instead of applying it.
 */
export function classifyCommand(
  state: GameState,
  action: CommandAction,
): CommandRejection | null {
  const { actorId, connectionId, at, gameNumber, roundNumber } = action;
  const { command } = action;

  // A cached command id was accepted before: replaying it is a no-op accept.
  if (state.appliedCommandIds.includes(action.commandId)) {
    return null;
  }
  if (gameNumber !== state.gameNumber) {
    return 'STALE';
  }
  if (roundNumber !== (state.round ? state.round.number : 0)) {
    return 'STALE';
  }
  if (deadlineDue(state, at)) {
    return 'STALE';
  }
  if (command.type === 'JOIN') {
    return classifyJoin(state, actorId, connectionId, command.nickname);
  }

  const actor = state.players[actorId];
  if (!actor) {
    return 'FORBIDDEN';
  }
  if (actor.status === 'kicked') {
    return 'KICKED';
  }
  if (actor.status === 'left' || !actor.connected) {
    return 'FORBIDDEN';
  }
  if (actor.connectionId !== connectionId) {
    return 'STALE';
  }

  const round = state.round;
  const phase = state.phase.type;
  const isHost = actorId === state.hostId;

  switch (command.type) {
    case 'LEAVE':
      return null;
    case 'SOUND_STATUS':
      return actor.soundUnlocked === command.unlocked ? 'NOT_READY' : null;
    case 'SET_SETTINGS': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      if (phase !== 'LOBBY') {
        return 'WRONG_PHASE';
      }
      return settingsEqual(state.settings, command.settings)
        ? 'NOT_READY'
        : null;
    }
    case 'KICK': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      const target = state.players[command.playerId];
      if (
        !target ||
        target.id === actorId ||
        target.status === 'kicked' ||
        target.status === 'left'
      ) {
        return 'INVALID';
      }
      return null;
    }
    case 'START_GAME': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      if (phase !== 'LOBBY') {
        return 'WRONG_PHASE';
      }
      const active = activePlayers(state.players);
      if (
        active.length < MIN_PLAYERS ||
        active.length > MAX_PLAYERS ||
        active.some((player) => !player.soundUnlocked)
      ) {
        return 'NOT_READY';
      }
      return null;
    }
    case 'SUBMIT_SONG': {
      if (!round || phase !== 'SUBMISSION' || state.pause) {
        return 'WRONG_PHASE';
      }
      if (!round.participantIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      if (round.submissionDoneIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      const existing = round.submissions[actorId];
      if (
        existing &&
        existing.media.videoId === command.media.videoId &&
        existing.media.title === command.media.title &&
        existing.media.channel === command.media.channel &&
        existing.media.thumbnail === command.media.thumbnail &&
        existing.media.durationSeconds === command.media.durationSeconds &&
        existing.media.startSeconds === command.media.startSeconds
      ) {
        return 'NOT_READY';
      }
      return null;
    }
    case 'REMOVE_SUBMISSION':
    case 'FINISH_SUBMISSION': {
      if (!round || phase !== 'SUBMISSION' || state.pause) {
        return 'WRONG_PHASE';
      }
      if (!round.participantIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      if (round.submissionDoneIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      if (command.type === 'REMOVE_SUBMISSION' && !round.submissions[actorId]) {
        return 'INVALID';
      }
      return null;
    }
    case 'RATE': {
      if (!round || state.phase.type !== 'PLAYBACK' || state.pause) {
        return 'WRONG_PHASE';
      }
      if (!round.participantIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      if (
        !Number.isInteger(command.value) ||
        command.value < 0 ||
        command.value > MAX_RATING
      ) {
        return 'INVALID';
      }
      const song = round.songs.find(
        (candidate) => candidate.media.videoId === command.songId,
      );
      // A song opens for rating when it starts (preroll included) and stays
      // open until the PLAYBACK phase ends.
      if (
        !song ||
        song.ownerIds.includes(actorId) ||
        round.playbackOrder.indexOf(command.songId) > state.phase.index
      ) {
        return 'INVALID';
      }
      return round.ratings[actorId]?.[command.songId] === command.value
        ? 'NOT_READY'
        : null;
    }
    case 'SKIP_VOTE': {
      if (!round || state.phase.type !== 'PLAYBACK' || state.pause) {
        return 'WRONG_PHASE';
      }
      if (!round.participantIds.includes(actorId)) {
        return 'FORBIDDEN';
      }
      // A vote for any song but the current one is a stale vote that crossed
      // an advance on the wire.
      if (command.songId !== round.playbackOrder[state.phase.index]) {
        return 'NOT_READY';
      }
      const ownsSong = round.songs.some(
        (song) =>
          song.media.videoId === command.songId &&
          song.ownerIds.includes(actorId),
      );
      if (!ownsSong && round.ratings[actorId]?.[command.songId] === undefined) {
        return 'FORBIDDEN';
      }
      return state.phase.skipVoterIds.includes(actorId) === command.skip
        ? 'NOT_READY'
        : null;
    }
    case 'ADVANCE':
    case 'PAUSE': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      return !state.pause && 'deadlineAt' in state.phase ? null : 'WRONG_PHASE';
    }
    case 'RESUME': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      if (!state.pause) {
        return 'WRONG_PHASE';
      }
      if (
        connectedParticipantCount(state) < MIN_PLAYERS &&
        !command.forceBelowMinimum
      ) {
        return 'NOT_READY';
      }
      return null;
    }
    case 'END_GAME': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      return 'deadlineAt' in state.phase ? null : 'WRONG_PHASE';
    }
    case 'REMATCH': {
      if (!isHost) {
        return 'FORBIDDEN';
      }
      return phase === 'FINAL' ? null : 'WRONG_PHASE';
    }
    default:
      return null;
  }
}

/**
 * Deterministic host election from an authoritative full presence list
 * (SPEC §3, plan rule 9, host migration contract). The caller supplies the
 * exact connection ids present at the moment of migration: election never
 * trusts the stale per-player `connected` flag baked into the snapshot.
 * Retained non-left/non-kicked identities whose stored connection id is
 * present are eligible; players win over spectators, `joinedAt` then code-unit
 * id break ties. Returns `null` when the list has duplicates or no candidate
 * survives; callers must not fall back to the previous host.
 */
export function electHost(
  state: GameState,
  connectionIds: readonly string[],
): string | null {
  if (new Set(connectionIds).size !== connectionIds.length) {
    return null;
  }
  const present = new Set(connectionIds);
  const retained = Object.values(state.players).filter(
    (player) =>
      player.status !== 'left' &&
      player.status !== 'kicked' &&
      present.has(player.connectionId),
  );
  const players = retained.filter((player) => player.status === 'player');
  const pool = players.length > 0 ? players : retained;
  return sortPlayers(pool)[0]?.id ?? null;
}

function reduceCommand(state: GameState, action: CommandAction): GameState {
  if (state.appliedCommandIds.includes(action.commandId)) {
    return state;
  }
  // A command that arrives with a due deadline loses: the deadline wins.
  if (deadlineDue(state, action.at)) {
    return transition(state, action.at);
  }
  if (classifyCommand(state, action) !== null) {
    return state;
  }
  return applyCommand(state, action);
}

function applyCommand(state: GameState, action: CommandAction): GameState {
  const { actorId, at, commandId } = action;
  const { command } = action;
  const commit = (patch: Partial<GameState>): GameState => ({
    ...state,
    ...patch,
    appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
    stateVersion: state.stateVersion + 1,
  });
  const round = state.round;
  const phaseType = state.phase.type;

  switch (command.type) {
    case 'JOIN':
      return join(state, action);
    case 'LEAVE':
      return leave(state, action);
    case 'SOUND_STATUS': {
      const actor = state.players[actorId];
      if (!actor) {
        return state;
      }
      return commit({
        players: {
          ...state.players,
          [actorId]: { ...actor, soundUnlocked: command.unlocked },
        },
      });
    }
    case 'SET_SETTINGS': {
      if (phaseType !== 'LOBBY') {
        return state;
      }
      const settings = copySettings(command.settings);
      const pool = genrePoolForSettings(settings, state.rouletteGenrePool);
      return commit({
        settings,
        genrePool: pool,
        remainingGenreIds: initialRemainingGenreIds(settings, pool),
      });
    }
    case 'KICK': {
      const target = state.players[command.playerId];
      if (!target) {
        return state;
      }
      const drafted: GameState = {
        ...state,
        players: {
          ...state.players,
          [target.id]: { ...target, status: 'kicked', connected: false },
        },
        appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
      };
      return finishQuorum(drafted, at, target.connected ? 1 : 0);
    }
    case 'START_GAME': {
      const drafted: GameState = {
        ...state,
        gameNumber: state.gameNumber + 1,
        appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
      };
      return startRound(drafted, at);
    }
    case 'SUBMIT_SONG': {
      if (!round || phaseType !== 'SUBMISSION') {
        return state;
      }
      const existing = round.submissions[actorId];
      let acceptedOrder: number;
      let nextSubmissionOrder = round.nextSubmissionOrder;
      if (existing && existing.media.videoId === command.media.videoId) {
        acceptedOrder = existing.acceptedOrder;
      } else {
        acceptedOrder = nextSubmissionOrder;
        nextSubmissionOrder += 1;
      }
      return commit({
        round: {
          ...round,
          submissions: {
            ...round.submissions,
            [actorId]: { media: { ...command.media }, acceptedOrder },
          },
          nextSubmissionOrder,
        },
      });
    }
    case 'REMOVE_SUBMISSION': {
      if (!round || phaseType !== 'SUBMISSION' || !round.submissions[actorId]) {
        return state;
      }
      const submissions = { ...round.submissions };
      delete submissions[actorId];
      return commit({ round: { ...round, submissions } });
    }
    case 'FINISH_SUBMISSION': {
      if (!round || phaseType !== 'SUBMISSION') {
        return state;
      }
      const drafted: GameState = {
        ...state,
        round: {
          ...round,
          submissionDoneIds: [...round.submissionDoneIds, actorId],
        },
        appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
      };
      return allSubmissionDone(drafted)
        ? enterPlaybackOrReveal(drafted, at)
        : { ...drafted, stateVersion: drafted.stateVersion + 1 };
    }
    case 'RATE': {
      if (!round || phaseType !== 'PLAYBACK') {
        return state;
      }
      return commit({
        round: {
          ...round,
          ratings: {
            ...round.ratings,
            [actorId]: {
              ...round.ratings[actorId],
              [command.songId]: command.value,
            },
          },
        },
      });
    }
    case 'SKIP_VOTE': {
      if (state.phase.type !== 'PLAYBACK') {
        return state;
      }
      const voters = state.phase.skipVoterIds;
      return commit({
        phase: {
          ...state.phase,
          skipVoterIds: command.skip
            ? [...voters, actorId]
            : voters.filter((id) => id !== actorId),
        },
      });
    }
    case 'ADVANCE': {
      const drafted: GameState = {
        ...state,
        appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
      };
      return transition(drafted, at);
    }
    case 'PAUSE':
      return commit({ pause: { at, reason: 'host' } });
    case 'RESUME': {
      if (!state.pause) {
        return state;
      }
      const belowMinimum = connectedParticipantCount(state) < MIN_PLAYERS;
      return commit({
        phase: shiftPhase(state.phase, Math.max(0, at - state.pause.at)),
        pause: null,
        forceBelowMinimum: belowMinimum,
      });
    }
    case 'END_GAME':
      return commit({
        phase: { type: 'FINAL', reason: 'hostEnded' },
        pause: null,
        forceBelowMinimum: false,
      });
    case 'REMATCH':
      return {
        ...state,
        players: resetPlayers(state.players),
        phase: { type: 'LOBBY' },
        round: null,
        results: [],
        pause: null,
        forceBelowMinimum: false,
        appliedCommandIds: [],
        stateVersion: state.stateVersion + 1,
      };
    default:
      return state;
  }
}

/**
 * FR-43: a command, leave, kick or presence change that leaves the skip quorum
 * reached ends the current song at once. The next song starts after the normal
 * preroll (`advancePlayback`); a quorum pause blocks it.
 */
function skipAfter(before: GameState, after: GameState, at: number): GameState {
  return after !== before && skipReached(after)
    ? advancePlayback(after, at)
    : after;
}

function skipReached(state: GameState): boolean {
  if (state.phase.type !== 'PLAYBACK' || state.pause) {
    return false;
  }
  const total = connectedParticipantCount(state);
  if (total === 0) {
    return false;
  }
  return skipVoteCount(state) >= skipThreshold(total);
}

/** Votes of connected participants; an offline voter counts again on reconnect. */
export function skipVoteCount(state: GameState): number {
  return state.phase.type === 'PLAYBACK'
    ? state.phase.skipVoterIds.filter((id) => isActivePlayer(state.players[id]))
        .length
    : 0;
}

function reduceDeadline(state: GameState, action: DeadlineAction): GameState {
  if (!deadlineDue(state, action.at)) {
    return state;
  }
  return transition(state, action.at);
}

function reducePresenceSync(
  state: GameState,
  action: PresenceAction,
): GameState {
  if (new Set(action.connectionIds).size !== action.connectionIds.length) {
    return state;
  }
  const present = new Set(action.connectionIds);
  const players: Record<string, Player> = { ...state.players };
  let changed = false;
  let disconnects = 0;
  let active = 0;

  // Absent bindings drop first (role and round data are preserved), present
  // active bindings keep their slot.
  for (const player of Object.values(state.players)) {
    if (player.status === 'kicked') {
      continue;
    }
    if (!present.has(player.connectionId)) {
      if (player.connected) {
        players[player.id] = { ...player, connected: false };
        disconnects += 1;
        changed = true;
      }
      continue;
    }
    if (isActivePlayer(player)) {
      active += 1;
    }
  }

  // Retained inactive identities recover only while a slot is free, oldest
  // join first (code-unit id tie-break). Overflow stays disconnected with its
  // role and data intact; departed records are never revived here.
  const recoverable = Object.values(state.players).filter(
    (player) =>
      player.status !== 'kicked' &&
      player.status !== 'left' &&
      !player.connected &&
      present.has(player.connectionId),
  );
  for (const player of sortPlayers(recoverable)) {
    if (active >= MAX_PLAYERS) {
      break;
    }
    players[player.id] = { ...player, connected: true };
    active += 1;
    changed = true;
  }

  if (!changed) {
    return state;
  }
  return finishQuorum({ ...state, players }, action.at, disconnects);
}

function reduceHostChanged(
  state: GameState,
  action: HostChangedAction,
): GameState {
  if (action.hostEpoch !== state.hostEpoch + 1) {
    return state;
  }
  // The new epoch is adopted against the highest complete snapshot version,
  // never against a speculative presence bump.
  if (action.hostBaseVersion !== state.stateVersion) {
    return state;
  }
  const candidate = state.players[action.hostId];
  if (
    !candidate ||
    candidate.status === 'left' ||
    candidate.status === 'kicked' ||
    electHost(state, action.connectionIds) !== action.hostId
  ) {
    return state;
  }
  return {
    ...state,
    hostId: action.hostId,
    hostEpoch: action.hostEpoch,
    hostBaseVersion: action.hostBaseVersion,
    stateVersion: state.stateVersion + 1,
  };
}

function classifyJoin(
  state: GameState,
  actorId: string,
  connectionId: string,
  nickname: string,
): CommandRejection | null {
  const players = Object.values(state.players);
  const existing = state.players[actorId];
  if (existing?.status === 'kicked') {
    return 'KICKED';
  }
  let activeCount = 0;
  let connectionTaken = false;
  for (const player of players) {
    if (player.status === 'kicked') {
      continue;
    }
    // Any retained binding blocks a hijack, including a transiently
    // disconnected identity that still owns its connection id.
    if (player.id !== actorId && player.connectionId === connectionId) {
      connectionTaken = true;
    }
    if (isActivePlayer(player)) {
      activeCount += 1;
    }
  }
  if (connectionTaken) {
    return 'FORBIDDEN';
  }
  // Rebinding an admitted active identity never consumes another slot, so an
  // open tab can move to a new connection even at full capacity.
  if (existing && isActivePlayer(existing)) {
    return existing.connectionId === connectionId ? 'NOT_READY' : null;
  }
  // Reactivating a retained identity (transient drop, rejoin, left record)
  // additionally needs a free slot; overflow stays retained and inactive.
  if (activeCount >= MAX_PLAYERS) {
    return 'ROOM_FULL';
  }
  if (existing) {
    return null;
  }
  const trimmed = nickname.trim();
  if (trimmed.length === 0) {
    return 'INVALID';
  }
  const key = nicknameKey(trimmed);
  // Nicknames stay reserved for every retained record, so a reconnect keeps
  // its original name and parted players cannot have it stolen.
  if (players.some((player) => nicknameKey(player.nickname) === key)) {
    return 'NICKNAME_TAKEN';
  }
  return null;
}

function join(state: GameState, action: CommandAction): GameState {
  const { actorId, connectionId, at, commandId } = action;
  if (action.command.type !== 'JOIN') {
    return state;
  }
  const existing = state.players[actorId];
  if (existing) {
    const status =
      existing.status === 'left'
        ? reconnectStatus(state, actorId)
        : existing.status;
    return {
      ...state,
      players: {
        ...state.players,
        [actorId]: { ...existing, connectionId, connected: true, status },
      },
      appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
      stateVersion: state.stateVersion + 1,
    };
  }
  const nickname = action.command.nickname.trim();
  if (nickname.length === 0) {
    return state;
  }
  return {
    ...state,
    players: {
      ...state.players,
      [actorId]: {
        id: actorId,
        connectionId,
        nickname,
        joinedAt: at,
        status: state.phase.type === 'LOBBY' ? 'player' : 'spectator',
        connected: true,
        soundUnlocked: false,
        totalScore: 0,
      },
    },
    appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
    stateVersion: state.stateVersion + 1,
  };
}

function leave(state: GameState, action: CommandAction): GameState {
  const { actorId, connectionId, at, commandId } = action;
  const actor = state.players[actorId];
  if (
    !actor ||
    actor.status === 'kicked' ||
    actor.status === 'left' ||
    !actor.connected ||
    actor.connectionId !== connectionId
  ) {
    return state;
  }
  const drafted: GameState = {
    ...state,
    players: {
      ...state.players,
      [actorId]: { ...actor, connected: false, status: 'left' },
    },
    appliedCommandIds: rememberCommand(state.appliedCommandIds, commandId),
  };
  return finishQuorum(drafted, at, 1);
}

function transition(state: GameState, at: number): GameState {
  switch (state.phase.type) {
    case 'GENRE_SPIN':
      return {
        ...state,
        phase: {
          type: 'SUBMISSION',
          deadlineAt: at + state.settings.submissionSeconds * 1000,
        },
        stateVersion: state.stateVersion + 1,
      };
    case 'SUBMISSION':
      return enterPlaybackOrReveal(state, at);
    case 'PLAYBACK':
      return advancePlayback(state, at);
    case 'REVEAL':
      return leaveReveal(state, at);
    default:
      return state;
  }
}

function enterPlaybackOrReveal(state: GameState, at: number): GameState {
  const round = state.round;
  if (!round) {
    return state;
  }
  const songs = aggregateSongs(round, state.settings.clipSeconds);
  const aggregated: Round = {
    ...round,
    songs,
  };
  if (songs.length === 0) {
    return revealWithResult(
      { ...state, round: aggregated },
      at,
      scoreRound(aggregated, state.settings),
    );
  }
  const shuffled = shuffle(
    songs.map((_, index) => index),
    state.rngState,
  );
  const playbackOrder = shuffled.items.map(
    (index) => songs[index].media.videoId,
  );
  const firstSong = songs[shuffled.items[0]];
  const startAt = at + PRE_ROLL_MS;
  return {
    ...state,
    round: { ...aggregated, playbackOrder },
    rngState: shuffled.rngState,
    phase: {
      type: 'PLAYBACK',
      index: 0,
      startAt,
      deadlineAt: startAt + clipMilliseconds(firstSong.clipSeconds),
      skipVoterIds: [],
    },
    stateVersion: state.stateVersion + 1,
  };
}

function advancePlayback(state: GameState, at: number): GameState {
  const round = state.round;
  if (!round || state.phase.type !== 'PLAYBACK') {
    return state;
  }
  const nextIndex = state.phase.index + 1;
  if (nextIndex >= round.playbackOrder.length) {
    return enterReveal(state, at);
  }
  const song = round.songs.find(
    (candidate) => candidate.media.videoId === round.playbackOrder[nextIndex],
  );
  if (!song) {
    return state;
  }
  const startAt = at + PRE_ROLL_MS;
  return {
    ...state,
    phase: {
      type: 'PLAYBACK',
      index: nextIndex,
      startAt,
      deadlineAt: startAt + clipMilliseconds(song.clipSeconds),
      skipVoterIds: [],
    },
    stateVersion: state.stateVersion + 1,
  };
}

function enterReveal(state: GameState, at: number): GameState {
  const round = state.round;
  if (!round) {
    return state;
  }
  return revealWithResult(state, at, scoreRound(round, state.settings));
}

function revealWithResult(
  state: GameState,
  at: number,
  result: RoundResult,
): GameState {
  return {
    ...state,
    players: applyDeltas(state.players, result.playerDeltas),
    results: [...state.results, result],
    phase: {
      type: 'REVEAL',
      startedAt: at,
      deadlineAt:
        at +
        result.songs.reduce((total, song) => total + revealSlotMs(song), 0) +
        REVEAL_HOLD_MS,
    },
    stateVersion: state.stateVersion + 1,
  };
}

function leaveReveal(state: GameState, at: number): GameState {
  if (state.results.length >= state.settings.rounds) {
    return {
      ...state,
      phase: { type: 'FINAL', reason: 'completed' },
      stateVersion: state.stateVersion + 1,
    };
  }
  return startRound(state, at);
}

function startRound(state: GameState, at: number): GameState {
  const players = promoteSpectators(state.players);
  const participantIds = sortPlayers(activePlayers(players)).map(
    (player) => player.id,
  );
  const genreMode = state.settings.genre;
  const draw =
    genreMode.mode === 'fixed'
      ? {
          genre: genreMode.genre,
          remainingGenreIds: [genreMode.genre.id],
          rngState: state.rngState,
        }
      : drawGenre(state.genrePool, state.remainingGenreIds, state.rngState);
  const round: Round = {
    number: state.results.length + 1,
    genre: { ...draw.genre },
    participantIds,
    submissions: {},
    submissionDoneIds: [],
    nextSubmissionOrder: 0,
    songs: [],
    playbackOrder: [],
    ratings: {},
  };
  return {
    ...state,
    players,
    round,
    phase: {
      type: 'GENRE_SPIN',
      startedAt: at,
      deadlineAt: at + (genreMode.mode === 'fixed' ? FIXED_INTRO_MS : SPIN_MS),
    },
    remainingGenreIds: draw.remainingGenreIds,
    rngState: draw.rngState,
    pause: null,
    forceBelowMinimum: false,
    stateVersion: state.stateVersion + 1,
  };
}

function aggregateSongs(round: Round, clipLimit: number): Song[] {
  const entries = Object.entries(round.submissions)
    .map(([playerId, submission]) => ({
      playerId,
      order: submission.acceptedOrder,
      media: submission.media,
    }))
    .sort(
      (a, b) =>
        a.order - b.order ||
        (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
    );
  // Identical video ids and different uploads of one song share a group; the
  // first accepted submission is canonical (ratings key on its video id).
  return groupSameSongs(entries.map((entry) => entry.media)).map((indices) => {
    const members = indices.map((index) => entries[index]);
    const first = members[0];
    return {
      media: { ...first.media },
      memberVideoIds: [...new Set(members.map((entry) => entry.media.videoId))],
      ownerIds: members.map((entry) => entry.playerId),
      clipSeconds: Math.min(
        clipLimit,
        first.media.durationSeconds - first.media.startSeconds,
      ),
    };
  });
}

function promoteSpectators(
  players: Record<string, Player>,
): Record<string, Player> {
  let changed = false;
  const next: Record<string, Player> = { ...players };
  for (const player of Object.values(players)) {
    if (player.status === 'spectator' && player.connected) {
      next[player.id] = { ...player, status: 'player' };
      changed = true;
    }
  }
  return changed ? next : players;
}

function resetPlayers(players: Record<string, Player>): Record<string, Player> {
  const next: Record<string, Player> = {};
  for (const player of Object.values(players)) {
    if (player.status === 'kicked') {
      // The ban record survives the rematch, its score does not.
      next[player.id] = { ...player, totalScore: 0 };
    } else if (player.connected) {
      next[player.id] = { ...player, status: 'player', totalScore: 0 };
    } else {
      next[player.id] = {
        ...player,
        connected: false,
        status: 'left',
        totalScore: 0,
      };
    }
  }
  return next;
}

function allSubmissionDone(state: GameState): boolean {
  const round = state.round;
  if (!round) {
    return false;
  }
  return round.participantIds.every(
    (participantId) =>
      round.submissionDoneIds.includes(participantId) ||
      !isActivePlayer(state.players[participantId]),
  );
}

/** Quorum only counts connected players that are part of the current round. */
export function connectedParticipantCount(state: GameState): number {
  const round = state.round;
  if (!round) {
    return 0;
  }
  return round.participantIds.filter((participantId) =>
    isActivePlayer(state.players[participantId]),
  ).length;
}

function finishQuorum(
  state: GameState,
  at: number,
  disconnects: number,
): GameState {
  const quorum = quorumPatch(state, at, disconnects);
  return {
    ...state,
    ...(quorum ?? {}),
    stateVersion: state.stateVersion + 1,
  };
}

function quorumPatch(
  state: GameState,
  at: number,
  disconnects: number,
): Partial<GameState> | null {
  if (state.pause) {
    return null;
  }
  const clearGuard = state.forceBelowMinimum && disconnects > 0;
  if (!('deadlineAt' in state.phase)) {
    return clearGuard ? { forceBelowMinimum: false } : null;
  }
  const belowMinimum = connectedParticipantCount(state) < MIN_PLAYERS;
  if (belowMinimum && (!state.forceBelowMinimum || disconnects > 0)) {
    return { pause: { at, reason: 'quorum' }, forceBelowMinimum: false };
  }
  return clearGuard ? { forceBelowMinimum: false } : null;
}

function shiftPhase(phase: Phase, shift: number): Phase {
  switch (phase.type) {
    case 'GENRE_SPIN':
      return {
        ...phase,
        startedAt: phase.startedAt + shift,
        deadlineAt: phase.deadlineAt + shift,
      };
    case 'SUBMISSION':
      return { ...phase, deadlineAt: phase.deadlineAt + shift };
    case 'PLAYBACK':
      return {
        ...phase,
        startAt: phase.startAt + shift,
        deadlineAt: phase.deadlineAt + shift,
      };
    case 'REVEAL':
      return {
        ...phase,
        startedAt: phase.startedAt + shift,
        deadlineAt: phase.deadlineAt + shift,
      };
    default:
      return phase;
  }
}

/** Reveal slot of one scored song: bangers linger longer. */
export function revealSlotMs(song: { banger: boolean }): number {
  return song.banger ? BANGER_REVEAL_MS : REVEAL_PER_SONG_MS;
}

function deadlineDue(state: GameState, at: number): boolean {
  return (
    !state.pause && 'deadlineAt' in state.phase && at >= state.phase.deadlineAt
  );
}

function reconnectStatus(state: GameState, playerId: string): Player['status'] {
  if (
    state.phase.type === 'LOBBY' ||
    state.round?.participantIds.includes(playerId)
  ) {
    return 'player';
  }
  return 'spectator';
}

/**
 * Playback deadlines are integer server milliseconds; the stored clip length
 * stays the exact media-bounded seconds value. A positive clip keeps at least
 * one millisecond so playback always advances.
 */
function clipMilliseconds(clipSeconds: number): number {
  return Math.max(1, Math.round(clipSeconds * 1000));
}

function settingsEqual(left: Settings, right: Settings): boolean {
  if (
    left.genre.mode !== right.genre.mode ||
    left.rounds !== right.rounds ||
    left.submissionSeconds !== right.submissionSeconds ||
    left.clipSeconds !== right.clipSeconds ||
    left.anonymous !== right.anonymous ||
    left.genreFailPenalty !== right.genreFailPenalty ||
    left.linkedPoints !== right.linkedPoints
  ) {
    return false;
  }
  if (left.genre.mode === 'custom' && right.genre.mode === 'custom') {
    if (left.genre.items.length !== right.genre.items.length) {
      return false;
    }
    const rightItems = right.genre.items;
    return left.genre.items.every((item, index) => {
      const other = rightItems[index];
      return (
        other !== undefined &&
        item.id === other.id &&
        item.de === other.de &&
        item.en === other.en
      );
    });
  }
  if (left.genre.mode === 'fixed' && right.genre.mode === 'fixed') {
    const item = left.genre.genre;
    const other = right.genre.genre;
    return item.id === other.id && item.de === other.de && item.en === other.en;
  }
  return true;
}

function copySettings(settings: Settings): Settings {
  const genre = settings.genre;
  if (genre.mode === 'custom') {
    return {
      ...settings,
      genre: {
        mode: 'custom',
        items: genre.items.map((item) => ({ ...item })),
      },
    };
  }
  if (genre.mode === 'fixed') {
    return {
      ...settings,
      genre: { mode: 'fixed', genre: { ...genre.genre } },
    };
  }
  return { ...settings, genre: { mode: 'roulette' } };
}
