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
import {
  PRE_ROLL_MS,
  connectedParticipantCount,
  revealSlots,
  skipThreshold,
  skipVoteCount,
} from './reducer';
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
  /** Progress only: never the submitted content. */
  submissionDone: boolean;
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
  songs: SongView[];
  playbackIndex: number | null;
  currentVideoId: string | null;
}

export interface PlaybackView {
  song: SongView;
  index: number;
  songCount: number;
  /** Absolute server-normalized timestamps, shifted together on resume. */
  startAt: number;
  deadlineAt: number;
  /** Length of the shared preroll that ends at `startAt` (first song only). */
  prerollMs: number;
  pausedAt: number | null;
  /** The viewer's own rating of the current song (0 = genre-fail); null while unrated. */
  rating: number | null;
  /** The viewer may rate the current song right now (never an owner). */
  canRate: boolean;
  skip: SkipView;
}

/** Skip vote of the current song (FR-43). Counts only, never voter ids (AK-3). */
export interface SkipView {
  /** Votes of connected participants. */
  votes: number;
  /** Connected participants of the round. */
  total: number;
  /** Votes that end the song: ceil(0.9 x total). */
  required: number;
  /** The viewer has voted to skip. */
  voted: boolean;
  /** The viewer may vote or withdraw right now. */
  canVote: boolean;
  /** A non-owner participant who has not rated the song yet. */
  needsRating: boolean;
}

/** One song the viewer may have rated: the current and every earlier one. */
export interface RatingEntryView {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  /** Zero-based position in the playback order. */
  index: number;
  isCurrent: boolean;
  ownedByViewer: boolean;
  /** The viewer's own rating; null while unrated (always null for owners). */
  rating: number | null;
  canRate: boolean;
}

export interface ViewerChoices {
  isParticipant: boolean;
  submitted: boolean;
  submissionDone: boolean;
  media: MediaView | null;
  /** The viewer's own ratings by video id (never other players' ratings). */
  ratings: Record<string, number>;
}

export interface ViewerPermissions {
  /** The viewer holds the active write connection, regardless of phase/role. */
  canWrite: boolean;
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
  canRate: boolean;
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
  /** Mean rating in tenths (73 = 7.3); 50 when nobody could rate the song. */
  scoreTenths: number;
  ratingCount: number;
  banger: boolean;
  basis: ScoredSong['basis'];
  /** Winner bonus in tenths. */
  bonus: number;
  /** Points the owners earned in tenths, penalty included. */
  roundPoints: number;
  genreFailed: boolean;
  flaggerIds: string[];
  winner: boolean;
}

export interface StagedRevealEntryView extends RevealEntryView {
  /**
   * Absolute server time this entry is revealed at (ascending, one per song).
   * A late joiner only sees entries whose `revealAt` is already in the past.
   */
  revealAt: number;
  /** How long this entry owns the stage: longer for the round's first banger. */
  slotMs: number;
  /**
   * Whether this entry carries the full-screen banger show and its sound: only
   * the first banger of a round does. Later bangers keep their `banger` badge.
   */
  bangerShow: boolean;
}

export interface RevealView {
  roundNumber: number;
  genre: Genre;
  reason: RoundResult['reason'];
  /** Absolute server time the reveal phase started at. */
  startedAt: number;
  /** Absolute server time the phase ends (hold after the last entry). */
  deadlineAt: number;

  /** Frozen reference instant while paused; null while running. */
  pausedAt: number | null;
  /** Ascending score (winner last); equal scores keep the frozen submission order. */
  entries: StagedRevealEntryView[];
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
  /** Score change from the latest revealed round (0 before any result). */
  delta: number;
  /** Dense rank before the latest round's delta; equals `rank` if unchanged. */
  previousRank: number;
}

export interface FinalView {
  /** `hostEnded` finales may have fewer rounds than configured. */
  reason: Extract<Phase, { type: 'FINAL' }>['reason'];
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

/** Playback timing and privacy-safe controls for this exact viewer tab. */
export function selectPlayback(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): PlaybackView | null {
  const song = selectCurrentSong(state, viewerId);
  if (state.phase.type !== 'PLAYBACK' || !state.round || !song) {
    return null;
  }
  return {
    song,
    index: state.phase.index,
    songCount: state.round.playbackOrder.length,
    startAt: state.phase.startAt,
    prerollMs: PRE_ROLL_MS,
    deadlineAt: state.phase.deadlineAt,
    pausedAt: state.pause?.at ?? null,
    rating: state.round.ratings[viewerId]?.[song.videoId] ?? null,
    canRate: canRateNow(state, viewerId, viewerConnectionId, song),
    skip: skipView(state, viewerId, viewerConnectionId, song),
  };
}

function skipView(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
  song: SongView,
): SkipView {
  const access = viewerAccess(state, viewerId, viewerConnectionId);
  const total = connectedParticipantCount(state);
  const rated = state.round?.ratings[viewerId]?.[song.videoId] !== undefined;
  return {
    votes: skipVoteCount(state),
    total,
    required: skipThreshold(total),
    voted:
      state.phase.type === 'PLAYBACK' &&
      state.phase.skipVoterIds.includes(viewerId),
    canVote:
      access.participant && !access.paused && (song.ownedByViewer || rated),
    needsRating: access.participant && !song.ownedByViewer && !rated,
  };
}

/**
 * The songs the viewer can rate or re-rate while PLAYBACK runs (FR-40): the
 * current song plus every earlier one, in playback order. Owned songs are
 * listed with `canRate: false` so the UI can say "your song". Empty outside
 * PLAYBACK. Only the viewer's own ratings are ever exposed.
 */
export function selectRatingEntries(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
): RatingEntryView[] {
  const round = state.round;
  if (!round || state.phase.type !== 'PLAYBACK') {
    return [];
  }
  const current = state.phase.index;
  return roundSongs(state, round, viewerId)
    .slice(0, current + 1)
    .map((song, index) => ({
      videoId: song.videoId,
      title: song.title,
      channel: song.channel,
      thumbnail: song.thumbnail,
      index,
      isCurrent: index === current,
      ownedByViewer: song.ownedByViewer,
      rating: round.ratings[viewerId]?.[song.videoId] ?? null,
      canRate: canRateNow(state, viewerId, viewerConnectionId, song),
    }));
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
      media: null,
      ratings: {},
    };
  }
  const submission = round.submissions[viewerId];
  return {
    isParticipant: round.participantIds.includes(viewerId),
    submitted: submission !== undefined,
    submissionDone: round.submissionDoneIds.includes(viewerId),
    media: submission ? { ...submission.media } : null,
    ratings: { ...round.ratings[viewerId] },
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
  return {
    canWrite: access.bound,
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
    canRate:
      access.participant &&
      round !== null &&
      phase === 'PLAYBACK' &&
      !access.paused,
  };
}

export function selectReveal(state: GameState): RevealView | null {
  const round = state.round;
  const phase = state.phase;
  if (!round || phase.type !== 'REVEAL') {
    return null;
  }
  const result = state.results[state.results.length - 1];
  if (!result || result.number !== round.number) {
    return null;
  }
  let revealAt = phase.startedAt;
  const entries = revealEntries(state, result.songs);
  const slots = revealSlots(entries);
  const staged = entries.map((entry, index) => {
    const { slotMs, bangerShow } = slots[index]!;
    const stagedEntry = { ...entry, revealAt, slotMs, bangerShow };
    revealAt += slotMs;
    return stagedEntry;
  });
  return {
    roundNumber: result.number,
    genre: { ...result.genre },
    reason: result.reason,
    startedAt: phase.startedAt,
    deadlineAt: phase.deadlineAt,
    pausedAt: state.pause ? state.pause.at : null,
    // Worst first: each entry becomes visible once the slots before it ran.
    entries: staged,
  };
}

/** FINAL phase outcome for the finale surface (null outside FINAL). */
export function selectFinal(state: GameState): FinalView | null {
  return state.phase.type === 'FINAL' ? { reason: state.phase.reason } : null;
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
  const players = Object.values(state.players);
  const latest = state.results[state.results.length - 1];
  const deltas = latest ? latest.playerDeltas : {};
  const current = new Map(players.map((p) => [p.id, p.totalScore]));
  // The score before this round's delta is the animation's start position.
  const previous = new Map(
    players.map((p) => [p.id, p.totalScore - (deltas[p.id] ?? 0)]),
  );
  const compare = (scores: Map<string, number>, a: Player, b: Player) =>
    (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
    a.joinedAt - b.joinedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const denseRanks = (scores: Map<string, number>) => {
    const ranks = new Map<string, number>();
    let rank = 0;
    let previousScore: number | null = null;
    for (const player of [...players].sort((a, b) => compare(scores, a, b))) {
      const score = scores.get(player.id) ?? 0;
      if (previousScore === null || score !== previousScore) {
        rank += 1;
        previousScore = score;
      }
      ranks.set(player.id, rank);
    }
    return ranks;
  };
  const ranks = denseRanks(current);
  const previousRanks = denseRanks(previous);
  return [...players]
    .sort((a, b) => compare(current, a, b))
    .map((player) => ({
      rank: ranks.get(player.id) ?? 0,
      playerId: player.id,
      nickname: player.nickname,
      totalScore: player.totalScore,
      status: player.status,
      isSelf: player.id === viewerId,
      delta: deltas[player.id] ?? 0,
      previousRank: previousRanks.get(player.id) ?? 0,
    }));
}

interface ViewerAccess {
  round: Round | null;
  /** Round membership (or the lobby active list) used for role display. */
  member: boolean;
  /**
   * Membership plus the currently bound write connection: the write-level
   * participant flag. Older tabs of the same viewer stay read-only.
   */
  participant: boolean;
  bound: boolean;
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
    bound,
    participant: bound && member,
    isHost: bound && viewerId === state.hostId,
    paused: state.pause !== null,
    phase: state.phase.type,
  };
}

/** Whether the viewer may rate this song right now (FR-40). */
function canRateNow(
  state: GameState,
  viewerId: string,
  viewerConnectionId: string | null,
  song: SongView,
): boolean {
  const access = viewerAccess(state, viewerId, viewerConnectionId);
  return (
    access.participant &&
    !access.paused &&
    access.phase === 'PLAYBACK' &&
    !song.ownedByViewer
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
  // Ascending placement (FR-60): winners always close the reveal, even when a
  // genre-failed song scored higher and lost the bonus.
  return scored
    .map((scoredSong, index) => ({ scoredSong, index }))
    .sort(
      (a, b) =>
        Number(a.scoredSong.winner) - Number(b.scoredSong.winner) ||
        a.scoredSong.scoreTenths - b.scoredSong.scoreTenths ||
        a.index - b.index,
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
    scoreTenths: scored.scoreTenths,
    ratingCount: scored.ratingCount,
    banger: scored.banger,
    basis: scored.basis,
    bonus: scored.bonus,
    roundPoints: scored.ownerDeltas[firstOwner],
    genreFailed: scored.genreFailed,
    flaggerIds: [...scored.flaggerIds],
    winner: scored.winner,
  };
}
