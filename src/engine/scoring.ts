import type { Round, RoundResult, ScoredSong, Song } from '../shared/game';
import type { Settings } from '../shared/settings';

/**
 * Scores a finished round. Ranking k songs awards k points to first place down
 * to 1 point for the last listed place; unranked songs score 0 (FR-50). Rounds
 * with zero or one deduplicated song are degenerate: no points, no bonus and no
 * penalty, surfaced with an explicit reason for the UI hint (FR-54).
 */
export function scoreRound(round: Round, settings: Settings): RoundResult {
  const songs = round.songs;
  const reason: RoundResult['reason'] =
    songs.length === 0
      ? 'noSongs'
      : songs.length === 1
        ? 'singleSong'
        : 'normal';

  const playerDeltas: Record<string, number> = {};
  for (const participantId of round.participantIds) {
    playerDeltas[participantId] = 0;
  }

  if (reason !== 'normal') {
    return {
      number: round.number,
      genre: round.genre,
      reason,
      songs: songs.map((song) => degenerateSong(song)),
      playerDeltas,
    };
  }

  const borda: Record<string, number> = {};
  const flaggers: Record<string, string[]> = {};
  const genreFailed: Record<string, boolean> = {};
  for (const song of songs) {
    const videoId = song.media.videoId;
    borda[videoId] = 0;
    flaggers[videoId] = round.participantIds.filter((participantId) =>
      (round.genreFailFlags[participantId] ?? []).includes(videoId),
    );
    genreFailed[videoId] =
      flaggers[videoId].length * 2 >
      round.participantIds.length - song.ownerIds.length;
  }

  for (const ballot of Object.values(round.ballots)) {
    const ranked = ballot.ranking.length;
    ballot.ranking.forEach((videoId, index) => {
      if (videoId in borda) {
        borda[videoId] += ranked - index;
      }
    });
  }

  let highest: number | null = null;
  for (const song of songs) {
    const videoId = song.media.videoId;
    if (
      !genreFailed[videoId] &&
      (highest === null || borda[videoId] > highest)
    ) {
      highest = borda[videoId];
    }
  }

  const scoredSongs: ScoredSong[] = songs.map((song) => {
    const videoId = song.media.videoId;
    const score = borda[videoId];
    const failed = genreFailed[videoId];
    const winner = !failed && highest !== null && score === highest;
    const bonus = winner ? 2 : 0;
    const ownerDeltas: Record<string, number> = {};
    for (const ownerId of song.ownerIds) {
      const share =
        settings.linkedPoints === 'halfCeil'
          ? Math.ceil((score + bonus) / 2)
          : score + bonus;
      const delta = share + (failed ? settings.genreFailPenalty : 0);
      ownerDeltas[ownerId] = delta;
      playerDeltas[ownerId] = (playerDeltas[ownerId] ?? 0) + delta;
    }
    return {
      song,
      borda: score,
      flaggerIds: flaggers[videoId],
      genreFailed: failed,
      winner,
      bonus,
      ownerDeltas,
    };
  });

  return {
    number: round.number,
    genre: round.genre,
    reason,
    songs: scoredSongs,
    playerDeltas,
  };
}

function degenerateSong(song: Song): ScoredSong {
  const ownerDeltas: Record<string, number> = {};
  for (const ownerId of song.ownerIds) {
    ownerDeltas[ownerId] = 0;
  }
  return {
    song,
    borda: 0,
    flaggerIds: [],
    genreFailed: false,
    winner: false,
    bonus: 0,
    ownerDeltas,
  };
}
