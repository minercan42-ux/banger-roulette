import type {
  GameState,
  Phase,
  Player,
  Round,
  RoundResult,
  ScoredSong,
  Song,
} from '../shared/game';
import type { Genre, Media } from '../shared/primitives';
import type { Settings } from '../shared/settings';
import { MAX_PLAYERS, MIN_PLAYERS, isActivePlayer, sortPlayers } from './state';

/**
 * Public, typed UI views. This is the only `src/engine` module the UI layer may
 * import (see the eslint boundary rule) and it never returns raw engine state:
 * no `connectionId`, no command cache, no `hostEpoch`/`hostBaseVersion`, no
 * `rngState`. The known MVP limit that every client receives the full snapshot
 * (and can inspect it with DevTools) stays documented in `docs/SECURITY.md`.
 */

export interface OwnerView {
  id: string;
  nickname: string;
}

export interface MediaView {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSeconds: number;
  startSeconds: number;
}

export interface SongView {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSeconds: number;
  startSeconds: number;
  clipSeconds: number;
  /** How many players submitted this video id (public, drives the linked animation). */
  ownerCount: number;
  /** Whether the viewer submitted this song themselves. */
  ownedByViewer: boolean;
  /** Owner ids and nicknames; empty while anonymity hides them. */
  owners: OwnerView[];
  ownersVisible: boolean;
  /** Shared video submission, independent of whether owner names are visible. */
  linked: boolean;
}

export interface PlayerView {
  id: string;
  nickname: string;
  isSelf: boolean;
  isHost: boolean;
  status: Player['status'];
  connected: boolean;
  soundUnlocked: boolean;
  totalScore: number;
  isParticipant: boolean;
  /** Progress only: never the submitted or ranked content. */
  submissionDone: boolean;
  votingDone: boolean;
}

export interface RoomView {
  roomCode: string;
  gameNumber: number;
  hostId: string;
  phase: Phase['type'];
  paused: boolean;
  pauseReason: 'quorum' | 'host' | null;
  anonymous: boolean;
  ownersVisible: boolean;
  roundNumber: number | null;
  genre: Genre | null;
  totalRounds: number;
}

export interface PhaseTimerView {
  phase: Phase['type'];
  deadlineAt: number | null;
  totalMs: number | null;
  /** Frozen at the pause instant while paused. */
  remainingMs: number | null;
  paused: boolean;
}

export interface RoundView {
  number: number;
  genre: Genre;
  participantIds: string[];
  submissionDoneIds: string[];
  votingDoneIds: string[];
  songs: SongView[];
  playbackIndex: number | null;
  currentVideoId: string | null;
}

export interface ViewerChoices {
  isParticipant: boolean;
  submitted: boolean;
  submissionDone: boolean;
  votingDone: boolean;
  media: MediaView | null;
  ranking: string[];
  /** The viewer's own genre-fail flags for the current round. */
  flaggedVideoIds: string[];
}

export interface ViewerPermissions {
  isHost: boolean;
  isParticipant: boolean;
  canStartGame: boolean;
  canEditSettings: boolean;
  canKick: boolean;
  canAdvance: boolean;
  canPause: boolean;
  canResume: boolean;
  canEndGame: boolean;
  canRematch: boolean;
  canSubmit: boolean;
  canFinishSubmission: boolean;
  canRank: boolean;
  canFinishVoting: boolean;
  canSetGenreFail: boolean;
}

export interface LobbyReadinessView {
  connectedPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  soundLockedIds: string[];
  ready: boolean;
}

export interface RevealEntryView {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  startSeconds: number;
  clipSeconds: number;
  watchUrl: string;
  owners: OwnerView[];
  ownerCount: number;
  linked: boolean;
  borda: number;
  bonus: number;
  roundPoints: number;
  genreFailed: boolean;
  flaggerIds: string[];
  winner: boolean;
}

export interface RevealView {
  roundNumber: number;
  genre: Genre;
  reason: RoundResult['reason'];
  /** Ascending Borda; equal scores keep the frozen submission order. */
  entries: RevealEntryView[];
}

export interface RoundResultView {
  roundNumber: number;
  genre: Genre;
  reason: RoundResult['reason'];
  entries: RevealEntryView[];
}

export interface StandingView {
  /** Dense rank; equal scores share the same rank. */
  rank: number;
  playerId: string;
  nickname: string;
  totalScore: number;
  status: Player['status'];
  isSelf: boolean;
}

/**
 * Owner information is public once a round is revealed: without anonymity at
 * all times, with anonymity only in REVEAL and FINAL.
 */
export function areOwnersVisible(state: GameState): boolean {
  return (
    !state.settings.anonymous ||
    state.phase.type === 'REVEAL' ||
    state.phase.type === 'FINAL'
  );
}

export interface SettingsView {
  genreMode: Settings['genre']['mode'];
  rounds: number;
  submissionSeconds: number;
  clipSeconds: number;
  votingSeconds: number;
  anonymous: boolean;
  genreFailPenalty: number;
  linkedPoints: Settings['linkedPoints'];
  /** Custom list for the custom mode; empty otherwise. */
  customItems: Genre[];
  /** The single genre for the fixed mode; null otherwise. */
  fixedGenre: Genre | null;
}

/** Lobby settings read view; every returned object is a copy. */
export function selectSettings(state: GameState): SettingsView {
  const genre = state.settings.genre;
  return {
    genreMode: genre.mode,
    rounds: state.settings.rounds,
    submissionSeconds: state.settings.submissionSeconds,
    clipSeconds: state.settings.clipSeconds,
    votingSeconds: state.settings.votingSeconds,
    anonymous: state.settings.anonymous,
    genreFailPenalty: state.settings.genreFailPenalty,
    linkedPoints: state.settings.linkedPoints,
    customItems:
      genre.mode === 'custom' ? genre.items.map((item) => ({ ...item })) : [],
    fixedGenre: genre.mode === 'fixed' ? { ...genre.genre } : null,
  };
}

/**
 * Active genre pool for the selected mode: the injected roulette catalogue,
 * the custom list or the single fixed genre. Returned objects are copies.
 */
export function selectGenrePool(state: GameState): Genre[] {
  return state.genrePool.map((genre) => ({ ...genre }));
}

export function selectRoom(state: GameState): RoomView {
  const round = state.round;
  return {
    roomCode: state.roomCode,
    gameNumber: state.gameNumber,
    hostId: state.hostId,
    phase: state.phase.type,
    paused: state.pause !== null,
    pauseReason: state.pause ? state.pause.reason : null,
    anonymous: state.settings.anonymous,
    ownersVisible: areOwnersVisible(state),
    roundNumber: round ? round.number : null,
    genre: round ? { ...round.genre } : null,
    totalRounds: state.settings.rounds,
  };
}

export function selectPhaseTimer(
  state: GameState,
  now: number,
): PhaseTimerView {
  const phase = state.phase;
  if (!('deadlineAt' in phase)) {
    return {
      phase: phase.type,
      deadlineAt: null,
      totalMs: null,
      remainingMs: null,
      paused: state.pause !== null,
    };
  }
  const reference = state.pause ? state.pause.at : now;
  return {
    phase: phase.type,
    deadlineAt: phase.deadlineAt,
    totalMs: phaseTotalMs(state, phase),
    remainingMs: Math.max(0, phase.deadlineAt - reference),
    paused: state.pause !== null,
  };
}

export function selectLobbyReadiness(state: GameState): LobbyReadinessView {
  const active = Object.values(state.players).filter(isActivePlayer);
  const soundLockedIds = active
    .filter((player) => !player.soundUnlocked)
    .map((player) => player.id);
  return {
    connectedPlayers: active.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    soundLockedIds,
    ready:
      active.length >= MIN_PLAYERS &&
      active.length <= MAX_PLAYERS &&
      soundLockedIds.length === 0,
  };
}

export function selectRoster(state: GameState, viewerId: string): PlayerView[] {
  const round = state.round;
  return sortPlayers(Object.values(state.players)).map((player) => ({
    id: player.id,
    nickname: player.nickname,
    isSelf: player.id === viewerId,
    isHost: player.id === state.hostId,
    status: player.status,
    connected: player.connected,
    soundUnlocked: player.soundUnlocked,
    totalScore: player.totalScore,
    isParticipant: round
      ? round.participantIds.includes(player.id)
      : isActivePlayer(player),
    submissionDone: round ? round.submissionDoneIds.includes(player.id) : false,
    votingDone: round ? round.votingDoneIds.includes(player.id) : false,
  }));
}

export function selectRound(
  state: GameState,
  viewerId: string,
): RoundView | null {
  const round = state.round;
  if (!round) {
    return null;
  }
  const phase = state.phase;
  return {
    number: round.number,
    genre: { ...round.genre },
    participantIds: [...round.participantIds],
    submissionDoneIds: [...round.submissionDoneIds],
    votingDoneIds: [...round.votingDoneIds],
    songs: roundSongs(state, round, viewerId),
    playbackIndex: phase.type === 'PLAYBACK' ? phase.index : null,
    currentVideoId:
      phase.type === 'PLAYBACK' ? round.playbackOrder[phase.index] : null,
  };
}

export function selectSongs(state: GameState, viewerId: string): SongView[] {
  const round = state.round;
  return round ? roundSongs(state, round, viewerId) : [];
}

export function selectCurrentSong(
  state: GameState,
  viewerId: string,
): SongView | null {
  const round = state.round;
  const phase = state.phase;
  if (!round || phase.type !== 'PLAYBACK') {
    return null;
  }
  const currentVideoId = round.playbackOrder[phase.index];
  const song = round.songs.find(
    (candidate) => candidate.media.videoId === currentVideoId,
  );
  return song ? toSongView(state, song, viewerId) : null;
}

/**
 * Songs the viewer may rank: own and linked songs are excluded (FR-40) and the
 * caller must hold the viewer's bound write connection.
 */
export function selectEligibleSongs(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): SongView[] {
  return selectableSongs(state, viewerId, viewerConnectionId, 'rank');
}

/**
 * Songs the viewer may flag: own and linked songs are excluded (FR-34/41) and
 * the caller must hold the viewer's bound write connection.
 */
export function selectFlaggableSongs(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): SongView[] {
  return selectableSongs(state, viewerId, viewerConnectionId, 'flag');
}

export function selectViewerChoices(
  state: GameState,
  viewerId: string,
): ViewerChoices {
  const round = state.round;
  if (!round) {
    return {
      isParticipant: false,
      submitted: false,
      submissionDone: false,
      votingDone: false,
      media: null,
      ranking: [],
      flaggedVideoIds: [],
    };
  }
  const submission = round.submissions[viewerId];
  const ballot = round.ballots[viewerId];
  return {
    isParticipant: round.participantIds.includes(viewerId),
    submitted: submission !== undefined,
    submissionDone: round.submissionDoneIds.includes(viewerId),
    votingDone: round.votingDoneIds.includes(viewerId),
    media: submission ? { ...submission.media } : null,
    ranking: ballot ? [...ballot.ranking] : [],
    flaggedVideoIds: [...(round.genreFailFlags[viewerId] ?? [])],
  };
}

/**
 * Write hints for one viewer tab. `viewerConnectionId` is the connection the
 * caller believes it holds; only the connection currently bound to `viewerId`
 * opens writes, so an older tab of the same viewer is read-only (the approved
 * single-write-connection rule - raw snapshots stay spoofable, this is not
 * authentication). Display hints only: the engine stays authoritative and
 * `classifyCommand` re-checks phase, actor, connection-binding and
 * stale-scope guards for every command. Rate limiting is not implemented in
 * the engine; the M2 host adapter owns it.
 */
export function selectViewerPermissions(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): ViewerPermissions {
  const access = viewerAccess(state, viewerId, viewerConnectionId);
  const round = access.round;
  const phase = access.phase;
  const timed = 'deadlineAt' in state.phase;
  const submissionOpen =
    access.participant &&
    round !== null &&
    phase === 'SUBMISSION' &&
    !access.paused &&
    !round.submissionDoneIds.includes(viewerId);
  const votingOpen =
    access.participant &&
    round !== null &&
    phase === 'VOTING' &&
    !access.paused &&
    !round.votingDoneIds.includes(viewerId);
  return {
    isHost: access.isHost,
    isParticipant: access.member,
    canStartGame: access.isHost && phase === 'LOBBY',
    canEditSettings: access.isHost && phase === 'LOBBY',
    canKick: access.isHost,
    canAdvance: access.isHost && timed && !access.paused,
    canPause: access.isHost && timed && !access.paused,
    canResume: access.isHost && access.paused,
    canEndGame: access.isHost && timed,
    canRematch: access.isHost && phase === 'FINAL',
    canSubmit: submissionOpen,
    canFinishSubmission: submissionOpen,
    canRank: votingOpen,
    canFinishVoting: votingOpen,
    canSetGenreFail:
      permittedTargets(state, viewerId, viewerConnectionId, 'flag').length > 0,
  };
}

export function selectReveal(state: GameState): RevealView | null {
  const round = state.round;
  if (!round || state.phase.type !== 'REVEAL') {
    return null;
  }
  const result = state.results[state.results.length - 1];
  if (!result || result.number !== round.number) {
    return null;
  }
  return {
    roundNumber: result.number,
    genre: { ...result.genre },
    reason: result.reason,
    entries: revealEntries(state, result.songs),
  };
}

/** All revealed rounds, including their owner mapping. */
export function selectResults(state: GameState): RoundResultView[] {
  return state.results.map((result) => ({
    roundNumber: result.number,
    genre: { ...result.genre },
    reason: result.reason,
    entries: revealEntries(state, result.songs),
  }));
}

export function selectStandings(
  state: GameState,
  viewerId: string,
): StandingView[] {
  const sorted = Object.values(state.players).sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      a.joinedAt - b.joinedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let rank = 0;
  let previousScore: number | null = null;
  return sorted.map((player) => {
    if (previousScore === null || player.totalScore !== previousScore) {
      rank += 1;
      previousScore = player.totalScore;
    }
    return {
      rank,
      playerId: player.id,
      nickname: player.nickname,
      totalScore: player.totalScore,
      status: player.status,
      isSelf: player.id === viewerId,
    };
  });
}

type TargetKind = 'rank' | 'flag';

interface ViewerAccess {
  round: Round | null;
  /** Round membership (or the lobby active list) used for role display. */
  member: boolean;
  /**
   * Membership plus the currently bound write connection: the write-level
   * participant flag. Older tabs of the same viewer stay read-only.
   */
  participant: boolean;
  isHost: boolean;
  paused: boolean;
  phase: Phase['type'];
}

function viewerAccess(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): ViewerAccess {
  const player = state.players[viewerId];
  const round = state.round;
  const active = player !== undefined && isActivePlayer(player);
  const bound =
    active &&
    viewerConnectionId !== null &&
    player.connectionId === viewerConnectionId;
  const member = round ? round.participantIds.includes(viewerId) : active;
  return {
    round,
    member,
    participant: bound && member,
    isHost: bound && viewerId === state.hostId,
    paused: state.pause !== null,
    phase: state.phase.type,
  };
}

/**
 * Video ids the viewer may currently act on. Ranking and flagging are locked
 * by FINISH_VOTING; flagging is also set-once during playback but stays
 * retractable during voting, and own or linked songs are never targets.
 */
function permittedTargets(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
  kind: TargetKind,
): string[] {
  const access = viewerAccess(state, viewerId, viewerConnectionId);
  const round = access.round;
  if (!round || !access.participant || access.paused) {
    return [];
  }
  const finished = round.votingDoneIds.includes(viewerId);
  if (kind === 'rank') {
    if (access.phase !== 'VOTING' || finished) {
      return [];
    }
  } else {
    if (access.phase !== 'PLAYBACK' && access.phase !== 'VOTING') {
      return [];
    }
    if (access.phase === 'VOTING' && finished) {
      return [];
    }
  }
  const flagged = round.genreFailFlags[viewerId] ?? [];
  return round.songs
    .filter((song) => !song.ownerIds.includes(viewerId))
    .filter(
      (song) =>
        kind === 'rank' ||
        access.phase === 'VOTING' ||
        !flagged.includes(song.media.videoId),
    )
    .map((song) => song.media.videoId);
}

/** Ordered view of the songs the viewer may act on right now. */
function selectableSongs(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
  kind: TargetKind,
): SongView[] {
  const round = state.round;
  const permitted = new Set(
    permittedTargets(state, viewerId, viewerConnectionId, kind),
  );
  if (!round || permitted.size === 0) {
    return [];
  }
  return roundSongs(state, round, viewerId).filter((song) =>
    permitted.has(song.videoId),
  );
}

function phaseTotalMs(state: GameState, phase: Phase): number | null {
  switch (phase.type) {
    case 'GENRE_SPIN':
      return phase.deadlineAt - phase.startedAt;
    case 'SUBMISSION':
      return state.settings.submissionSeconds * 1000;
    case 'PLAYBACK':
      return phase.deadlineAt - phase.startAt;
    case 'VOTING':
      return state.settings.votingSeconds * 1000;
    case 'REVEAL':
      return phase.deadlineAt - phase.startedAt;
    default:
      return null;
  }
}

function roundSongs(
  state: GameState,
  round: Round,
  viewerId: string,
): SongView[] {
  const songs: SongView[] = [];
  for (const videoId of round.playbackOrder) {
    const song = round.songs.find(
      (candidate) => candidate.media.videoId === videoId,
    );
    if (song) {
      songs.push(toSongView(state, song, viewerId));
    }
  }
  return songs;
}

function toSongView(state: GameState, song: Song, viewerId: string): SongView {
  const visible = areOwnersVisible(state);
  return {
    videoId: song.media.videoId,
    title: song.media.title,
    channel: song.media.channel,
    thumbnail: song.media.thumbnail,
    durationSeconds: song.media.durationSeconds,
    startSeconds: song.media.startSeconds,
    clipSeconds: song.clipSeconds,
    ownerCount: song.ownerIds.length,
    ownedByViewer: song.ownerIds.includes(viewerId),
    owners: visible ? song.ownerIds.map((id) => ownerView(state, id)) : [],
    ownersVisible: visible,
    linked: song.ownerIds.length > 1,
  };
}

function ownerView(state: GameState, ownerId: string): OwnerView {
  return { id: ownerId, nickname: state.players[ownerId].nickname };
}

function revealEntries(
  state: GameState,
  scored: readonly ScoredSong[],
): RevealEntryView[] {
  return scored
    .map((scoredSong, index) => ({ scoredSong, index }))
    .sort(
      (a, b) => a.scoredSong.borda - b.scoredSong.borda || a.index - b.index,
    )
    .map(({ scoredSong }) => toRevealEntry(state, scoredSong));
}

function toRevealEntry(state: GameState, scored: ScoredSong): RevealEntryView {
  const media: Media = scored.song.media;
  const firstOwner = scored.song.ownerIds[0];
  // Canonical watch link for the winner banger, including the clip start.
  const watchBase = `https://www.youtube.com/watch?v=${media.videoId}`;
  const watch =
    media.startSeconds > 0
      ? `${watchBase}&t=${Math.floor(media.startSeconds)}s`
      : watchBase;
  return {
    videoId: media.videoId,
    title: media.title,
    channel: media.channel,
    thumbnail: media.thumbnail,
    startSeconds: media.startSeconds,
    clipSeconds: scored.song.clipSeconds,
    watchUrl: watch,
    owners: scored.song.ownerIds.map((id) => ownerView(state, id)),
    ownerCount: scored.song.ownerIds.length,
    linked: scored.song.ownerIds.length > 1,
    borda: scored.borda,
    bonus: scored.bonus,
    roundPoints: scored.ownerDeltas[firstOwner],
    genreFailed: scored.genreFailed,
    flaggerIds: [...scored.flaggerIds],
    winner: scored.winner,
  };
}
