import { z } from 'zod';
import {
  GenreSchema,
  Id,
  Ids,
  Int,
  MediaSchema,
  Nickname,
  RoomCode,
  Seconds,
  Time,
  VideoIds,
  unique,
  nicknameKey,
} from './primitives';
import { RequiredSettingsSchema } from './settings';

export const PlayerSchema = z.strictObject({
  id: Id,
  connectionId: Id,
  nickname: Nickname,
  joinedAt: Time,
  status: z.enum(['player', 'spectator', 'left', 'kicked']),
  connected: z.boolean(),
  soundUnlocked: z.boolean(),
  totalScore: z.number().int(),
});
export type Player = z.infer<typeof PlayerSchema>;
const SubmissionSchema = z.strictObject({
  media: MediaSchema,
  acceptedOrder: Int,
});
export const SongSchema = z.strictObject({
  media: MediaSchema,
  ownerIds: Ids.min(1),
  clipSeconds: Seconds.positive(),
});
export type Song = z.infer<typeof SongSchema>;
export const RoundSchema = z.strictObject({
  number: z.number().int().min(1).max(20),
  genre: GenreSchema,
  participantIds: Ids.min(1),
  submissions: z.record(Id, SubmissionSchema),
  submissionDoneIds: Ids,
  nextSubmissionOrder: Int,
  songs: z.array(SongSchema).max(10),
  playbackOrder: VideoIds,
  ballots: z.record(Id, z.strictObject({ ranking: VideoIds })),
  votingDoneIds: Ids,
  genreFailFlags: z.record(Id, VideoIds),
});
export type Round = z.infer<typeof RoundSchema>;
export const ScoredSongSchema = z.strictObject({
  song: SongSchema,
  borda: Int,
  flaggerIds: Ids,
  genreFailed: z.boolean(),
  winner: z.boolean(),
  bonus: Int,
  ownerDeltas: z.record(Id, z.number().int()),
});
export type ScoredSong = z.infer<typeof ScoredSongSchema>;
export const RoundResultSchema = z.strictObject({
  number: z.number().int().min(1).max(20),
  genre: GenreSchema,
  reason: z.enum(['normal', 'noSongs', 'singleSong']),
  songs: z.array(ScoredSongSchema).max(10),
  playerDeltas: z.record(Id, z.number().int()),
});
export type RoundResult = z.infer<typeof RoundResultSchema>;
export const PhaseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('LOBBY') }),
  z.strictObject({
    type: z.literal('GENRE_SPIN'),
    startedAt: Time,
    deadlineAt: Time,
  }),
  z.strictObject({ type: z.literal('SUBMISSION'), deadlineAt: Time }),
  z.strictObject({
    type: z.literal('PLAYBACK'),
    index: Int,
    startAt: Time,
    deadlineAt: Time,
  }),
  z.strictObject({ type: z.literal('VOTING'), deadlineAt: Time }),
  z.strictObject({
    type: z.literal('REVEAL'),
    startedAt: Time,
    deadlineAt: Time,
  }),
  z.strictObject({
    type: z.literal('FINAL'),
    reason: z.enum(['completed', 'hostEnded']),
  }),
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const GameStateSchema = z
  .strictObject({
    roomId: Id,
    roomCode: RoomCode,
    stateVersion: Int,
    gameNumber: Int,
    hostId: Id,
    hostEpoch: Int,
    hostBaseVersion: Int,
    settings: RequiredSettingsSchema,
    players: z.record(Id, PlayerSchema),
    genrePool: z.array(GenreSchema).min(1).max(50),
    rouletteGenrePool: z
      .array(GenreSchema)
      .min(30)
      .max(50)
      .refine(
        (genres) => unique(genres.map((genre) => genre.id)),
        'Duplicate roulette catalogue IDs',
      ),
    remainingGenreIds: z.array(z.string().min(1)).max(50),
    rngState: z.number().int().min(1).max(0xffffffff),
    phase: PhaseSchema,
    round: RoundSchema.nullable(),
    results: z.array(RoundResultSchema).max(20),
    pause: z
      .strictObject({ at: Time, reason: z.enum(['quorum', 'host']) })
      .nullable(),
    forceBelowMinimum: z.boolean(),
    appliedCommandIds: z.array(Id).max(256),
  })
  .superRefine((state, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const players = Object.values(state.players);
    const knownPlayer = (id: string) => Object.hasOwn(state.players, id);
    if (players.some((p) => state.players[p.id] !== p))
      issue('Player record key must match id');
    if (
      !knownPlayer(state.hostId) ||
      state.players[state.hostId]?.status === 'kicked'
    )
      issue('Invalid host');
    if (state.hostBaseVersion > state.stateVersion)
      issue('Host base exceeds version');
    const active = players.filter(
      (p) => p.connected && p.status !== 'kicked' && p.status !== 'left',
    );
    if (
      active.length > 10 ||
      !unique(active.map((p) => p.connectionId)) ||
      !unique(active.map((p) => nicknameKey(p.nickname)))
    )
      issue('Duplicate active connection/nickname or room full');
    if (
      players.some(
        (p) => (p.status === 'kicked' || p.status === 'left') && p.connected,
      )
    )
      issue('Departed player cannot be connected');
    const genreIds = state.genrePool.map((g) => g.id);
    if (
      !unique(genreIds) ||
      !unique(state.remainingGenreIds) ||
      state.remainingGenreIds.some((id) => !genreIds.includes(id))
    )
      issue('Invalid genre cycle');
    if (state.settings.genre.mode === 'roulette' && genreIds.length < 30)
      issue('Roulette requires thirty genres');
    if (
      state.settings.genre.mode === 'roulette' &&
      (genreIds.length !== state.rouletteGenrePool.length ||
        state.rouletteGenrePool.some((genre) => !genreIds.includes(genre.id)))
    )
      issue('Roulette pool must match injected catalogue');
    if (
      state.settings.genre.mode === 'custom' &&
      (genreIds.length !== state.settings.genre.items.length ||
        state.settings.genre.items.some((g) => !genreIds.includes(g.id)))
    )
      issue('Custom pool mismatch');
    if (
      state.settings.genre.mode === 'fixed' &&
      (genreIds.length !== 1 || genreIds[0] !== state.settings.genre.genre.id)
    )
      issue('Fixed pool mismatch');
    if (!unique(state.appliedCommandIds)) issue('Duplicate commands');
    if (
      state.results.length > state.settings.rounds ||
      state.results.some((r, i) => r.number !== i + 1)
    )
      issue('Results must be contiguous');
    if (
      state.phase.type === 'LOBBY' &&
      (state.round !== null ||
        state.pause !== null ||
        state.results.length !== 0)
    )
      issue('Lobby cannot contain round/results/pause');
    if (
      state.phase.type !== 'LOBBY' &&
      state.phase.type !== 'FINAL' &&
      !state.round
    )
      issue('Running phase requires round');
    if (state.phase.type === 'FINAL' && state.pause)
      issue('Final cannot be paused');
    if (
      state.phase.type === 'FINAL' &&
      state.phase.reason === 'completed' &&
      (!state.round ||
        state.results.length !== state.settings.rounds ||
        state.round.number !== state.results.length)
    )
      issue('Completed final requires all rounds');
    if (
      'startedAt' in state.phase &&
      state.phase.deadlineAt < state.phase.startedAt
    )
      issue('Deadline precedes start');
    if (
      state.phase.type === 'PLAYBACK' &&
      state.phase.deadlineAt < state.phase.startAt
    )
      issue('Deadline precedes playback');
    const round = state.round;
    if (round) {
      if (
        !genreIds.includes(round.genre.id) ||
        round.number > state.settings.rounds
      )
        issue('Unknown genre or excess round');
      if (
        state.phase.type !== 'FINAL' &&
        round.number !==
          state.results.length + (state.phase.type === 'REVEAL' ? 0 : 1)
      )
        issue('Round number mismatch');
      if (round.participantIds.some((id) => !knownPlayer(id)))
        issue('Unknown participant');
      const participant = (id: string) => round.participantIds.includes(id);
      const videos = round.songs.map((s) => s.media.videoId);
      if (
        !unique(videos) ||
        videos.length !== round.playbackOrder.length ||
        round.playbackOrder.some((id) => !videos.includes(id))
      )
        issue('Playback order must permute songs');
      if (
        state.phase.type === 'PLAYBACK' &&
        state.phase.index >= round.playbackOrder.length
      )
        issue('Invalid playback index');
      if (
        [
          ...Object.keys(round.submissions),
          ...round.submissionDoneIds,
          ...Object.keys(round.ballots),
          ...round.votingDoneIds,
          ...Object.keys(round.genreFailFlags),
        ].some((id) => !participant(id))
      )
        issue('Round action by nonparticipant');
      const orders = Object.values(round.submissions).map(
        (s) => s.acceptedOrder,
      );
      if (
        !unique(orders) ||
        orders.some((order) => order >= round.nextSubmissionOrder)
      )
        issue('Invalid submission order');
      for (const song of round.songs) {
        if (song.ownerIds.some((id) => !participant(id)))
          issue('Unknown song owner');
        if (
          song.clipSeconds > state.settings.clipSeconds ||
          song.clipSeconds >
            song.media.durationSeconds - song.media.startSeconds
        )
          issue('Clip exceeds bounds');
        const owners = Object.entries(round.submissions)
          .filter(([, s]) => s.media.videoId === song.media.videoId)
          .map(([id]) => id);
        if (
          owners.length !== song.ownerIds.length ||
          owners.some((id) => !song.ownerIds.includes(id))
        )
          issue('Song owner/submission mismatch');
      }
      for (const [id, ballot] of Object.entries(round.ballots))
        if (
          ballot.ranking.some(
            (video) =>
              !videos.includes(video) ||
              round.songs
                .find((s) => s.media.videoId === video)
                ?.ownerIds.includes(id),
          )
        )
          issue('Invalid or own ranked song');
      for (const [id, flags] of Object.entries(round.genreFailFlags))
        if (
          flags.some(
            (video) =>
              !videos.includes(video) ||
              round.songs
                .find((s) => s.media.videoId === video)
                ?.ownerIds.includes(id),
          )
        )
          issue('Invalid or own flagged song');
    }
    for (const result of state.results) {
      if (!genreIds.includes(result.genre.id)) issue('Unknown result genre');
      if (!unique(result.songs.map((s) => s.song.media.videoId)))
        issue('Duplicate result songs');
      if (Object.keys(result.playerDeltas).some((id) => !knownPlayer(id)))
        issue('Unknown scored player');
      if (
        result.reason !== 'normal' &&
        Object.values(result.playerDeltas).some((delta) => delta !== 0)
      )
        issue('Degenerate round must have zero player deltas');
      if (
        (result.reason === 'noSongs' && result.songs.length !== 0) ||
        (result.reason === 'singleSong' && result.songs.length !== 1) ||
        (result.reason === 'normal' && result.songs.length < 2)
      )
        issue('Result reason mismatch');
      for (const scored of result.songs) {
        if (
          scored.song.clipSeconds > state.settings.clipSeconds ||
          scored.song.clipSeconds >
            scored.song.media.durationSeconds - scored.song.media.startSeconds
        )
          issue('Result clip exceeds bounds');
        if (
          scored.song.ownerIds.some((id) => !knownPlayer(id)) ||
          scored.flaggerIds.some(
            (id) => !knownPlayer(id) || scored.song.ownerIds.includes(id),
          )
        )
          issue('Invalid result references');
        if (
          Object.keys(scored.ownerDeltas).length !==
            scored.song.ownerIds.length ||
          scored.song.ownerIds.some(
            (id) => !Object.hasOwn(scored.ownerDeltas, id),
          )
        )
          issue('Owner deltas mismatch');
        if (
          scored.bonus !== (scored.winner ? 2 : 0) ||
          (scored.genreFailed && scored.winner)
        )
          issue('Invalid winner bonus');
        if (
          result.reason !== 'normal' &&
          (scored.borda ||
            scored.bonus ||
            scored.genreFailed ||
            Object.values(scored.ownerDeltas).some((delta) => delta !== 0))
        )
          issue('Degenerate round must have zero points');
      }
    }
  });
export type GameState = z.infer<typeof GameStateSchema>;
