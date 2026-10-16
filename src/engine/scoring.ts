import {
  SCORE_TENTHS_PER_POINT,
  type Round,
  type RoundResult,
  type ScoredSong,
} from '../shared/game';
import type { Settings } from '../shared/settings';

/** Winner bonus: +2.0 points, in tenths (FR-51). */
export const WINNER_BONUS_TENTHS = 2 * SCORE_TENTHS_PER_POINT;
/** Fixed bonus for a song nobody is eligible to rate: 5.0 points (FR-50). */
export const NO_RATER_BONUS_TENTHS = 5 * SCORE_TENTHS_PER_POINT;
export const MAX_RATING = 10;

/**
 * Mean rating in integer tenths: `round(sum * 10 / count)`, half up, computed
 * in integers so no float error can flip a boundary (FR-50).
 */
export function meanTenths(sum: number, count: number): number {
  return Math.floor((sum * 2 * SCORE_TENTHS_PER_POINT + count) / (2 * count));
}

/**
 * Scores a finished round from the live 0-10 ratings (FR-50..FR-53). Every
 * number is an integer count of tenths of a point:
 *
 * - song score = mean of the ratings given; owners receive it as points (the
 *   linked-points setting halves it, rounded up, per owner);
 * - raters exist but nobody rated: score 0 (`noRating`);
 * - no eligible rater (every participant owns the song): fixed 5.0 to each
 *   owner, no winner bonus, no halving (`noRaters`);
 * - the best non-failed song(s) with raters get +2.0, ties share it;
 * - a majority of eligible raters flagging a song costs its owners the
 *   genre-fail penalty and excludes it from the bonus.
 *
 * A round without songs is degenerate: no points, no bonus, no penalty.
 */
export function scoreRound(round: Round, settings: Settings): RoundResult {
  const playerDeltas: Record<string, number> = {};
  for (const participantId of round.participantIds) {
    playerDeltas[participantId] = 0;
  }

  const drafts = round.songs.map((song) => {
    const videoId = song.media.videoId;
    const eligible = round.participantIds.filter(
      (participantId) => !song.ownerIds.includes(participantId),
    );
    let sum = 0;
    let count = 0;
    let allTens = true;
    for (const participantId of eligible) {
      const given = round.ratings[participantId]?.[videoId];
      if (given !== undefined) {
        sum += given;
        count += 1;
        allTens &&= given === MAX_RATING;
      }
    }
    const flaggerIds = eligible.filter((participantId) =>
      (round.genreFailFlags[participantId] ?? []).includes(videoId),
    );
    const basis: ScoredSong['basis'] =
      eligible.length === 0 ? 'noRaters' : count === 0 ? 'noRating' : 'ratings';
    return {
      song,
      basis,
      count,
      banger: count > 0 && allTens,
      scoreTenths:
        basis === 'noRaters'
          ? NO_RATER_BONUS_TENTHS
          : count === 0
            ? 0
            : meanTenths(sum, count),
      flaggerIds,
      genreFailed: flaggerIds.length * 2 > eligible.length,
    };
  });

  let highest: number | null = null;
  for (const draft of drafts) {
    if (
      draft.basis !== 'noRaters' &&
      !draft.genreFailed &&
      (highest === null || draft.scoreTenths > highest)
    ) {
      highest = draft.scoreTenths;
    }
  }

  const songs: ScoredSong[] = drafts.map((draft) => {
    const winner =
      draft.basis !== 'noRaters' &&
      !draft.genreFailed &&
      draft.scoreTenths === highest;
    const bonus = winner ? WINNER_BONUS_TENTHS : 0;
    const ownerDeltas: Record<string, number> = {};
    for (const ownerId of draft.song.ownerIds) {
      const earned =
        draft.basis === 'noRaters'
          ? draft.scoreTenths
          : settings.linkedPoints === 'halfCeil'
            ? Math.ceil((draft.scoreTenths + bonus) / 2)
            : draft.scoreTenths + bonus;
      const delta =
        earned +
        (draft.genreFailed
          ? settings.genreFailPenalty * SCORE_TENTHS_PER_POINT
          : 0);
      ownerDeltas[ownerId] = delta;
      playerDeltas[ownerId] = (playerDeltas[ownerId] ?? 0) + delta;
    }
    return {
      song: draft.song,
      scoreTenths: draft.scoreTenths,
      ratingCount: draft.count,
      banger: draft.banger,
      basis: draft.basis,
      flaggerIds: draft.flaggerIds,
      genreFailed: draft.genreFailed,
      winner,
      bonus,
      ownerDeltas,
    };
  });

  return {
    number: round.number,
    genre: round.genre,
    reason: songs.length === 0 ? 'noSongs' : 'normal',
    songs,
    playerDeltas,
  };
}
