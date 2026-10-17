import { describe, expect, it } from 'vitest';
import type { Round, RoundResult, ScoredSong, Song } from '../shared/game';
import { meanTenths, scoreRound } from './scoring';
import { genre, id, makeSettings, media, videoId } from './fixtures';

function songsFor(songOwners: string[]): Song[] {
  return songOwners.map((ownerId, index) => ({
    media: media(videoId(index + 1)),
    memberVideoIds: [videoId(index + 1)],
    ownerIds: [ownerId],
    clipSeconds: 20,
  }));
}

function roundWith(
  songs: Song[],
  ratings: Record<string, Record<string, number>>,
  participantIds: string[] = owners,
): Round {
  return {
    number: 1,
    genre: genre(0),
    participantIds,
    submissions: {},
    submissionDoneIds: [],
    nextSubmissionOrder: songs.length,
    songs,
    playbackOrder: songs.map((song) => song.media.videoId),
    ratings,
  };
}

const owners = [id(1), id(2), id(3), id(4)];

function songOf(result: RoundResult, video: string): ScoredSong {
  const scored = result.songs.find(
    (candidate) => candidate.song.media.videoId === video,
  );
  if (!scored) {
    throw new Error(`missing scored song ${video}`);
  }
  return scored;
}

describe('meanTenths', () => {
  it('rounds the mean to integer tenths, half up', () => {
    expect(meanTenths(22, 3)).toBe(73); // 7.333 -> 7.3
    expect(meanTenths(3, 2)).toBe(15); // 1.5 -> 1.5
    expect(meanTenths(1, 2)).toBe(5); // 0.5 -> half up
    expect(meanTenths(5, 2)).toBe(25); // 2.5 -> half up
    expect(meanTenths(7, 2)).toBe(35); // 3.5 -> half up
    expect(meanTenths(30, 3)).toBe(100);
    expect(meanTenths(0, 3)).toBe(0);
  });
});

describe('scoreRound', () => {
  it('scores the mean of the ratings as owner points', () => {
    const songs = songsFor(owners);
    const result = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 7 },
        [id(3)]: { [videoId(1)]: 7 },
        [id(4)]: { [videoId(1)]: 8 },
      }),
      makeSettings(),
    );
    expect(result.reason).toBe('normal');
    const winner = songOf(result, videoId(1));
    expect(winner).toMatchObject({
      scoreTenths: 73,
      ratingCount: 3,
      banger: false,
      basis: 'ratings',
      winner: true,
      bonus: 20,
    });
    expect(winner.ownerDeltas[id(1)]).toBe(93);
    expect(result.playerDeltas).toEqual({
      [id(1)]: 93,
      [id(2)]: 0,
      [id(3)]: 0,
      [id(4)]: 0,
    });
  });

  it('rounds a 1 and a 2 to 1.5 for the owner', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 1 },
        [id(3)]: { [videoId(1)]: 2 },
      }),
      makeSettings(),
    );
    expect(songOf(result, videoId(1))).toMatchObject({
      scoreTenths: 15,
      ratingCount: 2,
      basis: 'ratings',
    });
  });

  it('flags a banger only when every rating is a ten', () => {
    const songs = songsFor([id(1), id(2)]);
    const twoTens = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 10 },
        [id(3)]: { [videoId(1)]: 10 },
      }),
      makeSettings(),
    );
    expect(songOf(twoTens, videoId(1))).toMatchObject({
      scoreTenths: 100,
      ratingCount: 2,
      banger: true,
      basis: 'ratings',
    });
    const oneTen = scoreRound(
      roundWith(songs, { [id(2)]: { [videoId(1)]: 10 } }),
      makeSettings(),
    );
    expect(songOf(oneTen, videoId(1))).toMatchObject({
      scoreTenths: 100,
      ratingCount: 1,
      banger: true,
    });
    const withNine = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 10 },
        [id(3)]: { [videoId(1)]: 9 },
      }),
      makeSettings(),
    );
    expect(songOf(withNine, videoId(1))).toMatchObject({
      banger: false,
      scoreTenths: 95,
    });
    const rated = scoreRound(roundWith(songs, {}), makeSettings());
    expect(songOf(rated, videoId(1))).toMatchObject({
      banger: false,
      basis: 'noRating',
    });
  });

  it('shares the winner bonus between every song tied at the top', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(
        songs,
        {
          [id(3)]: { [videoId(1)]: 5, [videoId(2)]: 5 },
        },
        [id(1), id(2), id(3)],
      ),
      makeSettings(),
    );
    for (const video of [videoId(1), videoId(2)]) {
      expect(songOf(result, video)).toMatchObject({
        scoreTenths: 50,
        winner: true,
        bonus: 20,
      });
    }
    expect(result.playerDeltas).toEqual({
      [id(1)]: 70,
      [id(2)]: 70,
      [id(3)]: 0,
    });
  });

  it('gives every owner the fixed 5.0 when nobody may rate', () => {
    const song: Song = {
      media: media(videoId(1)),
      memberVideoIds: [videoId(1)],
      ownerIds: [id(1), id(2), id(3)],
      clipSeconds: 20,
    };
    const participants = [id(1), id(2), id(3)];
    const result = scoreRound(
      roundWith([song], {}, participants),
      makeSettings(),
    );
    expect(songOf(result, videoId(1))).toMatchObject({
      scoreTenths: 50,
      ratingCount: 0,
      banger: false,
      basis: 'noRaters',
      winner: false,
      bonus: 0,
    });
    expect(result.playerDeltas).toEqual({
      [id(1)]: 50,
      [id(2)]: 50,
      [id(3)]: 50,
    });
    // The linked-points setting must not halve the fixed no-rater bonus.
    const half = scoreRound(
      roundWith([song], {}, participants),
      makeSettings({ linkedPoints: 'halfCeil' }),
    );
    expect(half.playerDeltas).toEqual({
      [id(1)]: 50,
      [id(2)]: 50,
      [id(3)]: 50,
    });
  });

  it('scores an unrated song zero but keeps it in the bonus race', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(songs, {}, [id(1), id(2), id(3)]),
      makeSettings(),
    );
    for (const video of [videoId(1), videoId(2)]) {
      expect(songOf(result, video)).toMatchObject({
        scoreTenths: 0,
        ratingCount: 0,
        basis: 'noRating',
        winner: true,
        bonus: 20,
      });
    }
    expect(result.playerDeltas).toEqual({
      [id(1)]: 20,
      [id(2)]: 20,
      [id(3)]: 0,
    });
  });

  it('counts a genre-fail 0 in the mean without failing the song alone', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 10 },
        [id(3)]: { [videoId(1)]: 10 },
        [id(4)]: { [videoId(1)]: 0 },
      }),
      makeSettings(),
    );
    // (10 + 10 + 0) / 3 = 6.67 -> 6.7; one of three is no majority.
    expect(songOf(result, videoId(1))).toMatchObject({
      scoreTenths: 67,
      ratingCount: 3,
      banger: false,
      genreFailed: false,
      flaggerIds: [id(4)],
      winner: true,
      bonus: 20,
    });
  });

  it('penalises a genre fail and excludes it from the winner bonus', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 0 },
        [id(3)]: { [videoId(1)]: 0, [videoId(2)]: 5 },
        [id(4)]: { [videoId(1)]: 8, [videoId(2)]: 0 },
      }),
      makeSettings(),
    );
    const failed = songOf(result, videoId(1));
    // (0 + 0 + 8) / 3 = 2.67 -> 2.7; two of three eligible rated 0.
    expect(failed).toMatchObject({
      scoreTenths: 27,
      genreFailed: true,
      winner: false,
      bonus: 0,
      flaggerIds: [id(2), id(3)],
    });
    // 2.7 of points minus the full 3.0 genre-fail penalty.
    expect(failed.ownerDeltas[id(1)]).toBe(-3);
    const winner = songOf(result, videoId(2));
    expect(winner).toMatchObject({
      scoreTenths: 25,
      genreFailed: false,
      winner: true,
      bonus: 20,
    });
    expect(winner.flaggerIds).toEqual([id(4)]);
  });

  it('requires a strict majority of the eligible raters at 0', () => {
    const songs = songsFor([id(1), id(2)]);
    const minority = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 0 },
        [id(3)]: { [videoId(1)]: 8 },
        [id(4)]: { [videoId(1)]: 8 },
      }),
      makeSettings(),
    );
    expect(songOf(minority, videoId(1))).toMatchObject({
      genreFailed: false,
      winner: true,
      bonus: 20,
    });
    const majority = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 0 },
        [id(3)]: { [videoId(1)]: 0 },
        [id(4)]: { [videoId(1)]: 8 },
      }),
      makeSettings(),
    );
    expect(songOf(majority, videoId(1))).toMatchObject({
      genreFailed: true,
      winner: false,
      bonus: 0,
    });
  });

  it('removes the flagger when a 0 becomes a 7', () => {
    const songs = songsFor([id(1), id(2)]);
    const rated = (second: number) =>
      scoreRound(
        roundWith(songs, {
          [id(2)]: { [videoId(1)]: 0 },
          [id(3)]: { [videoId(1)]: second },
          [id(4)]: { [videoId(1)]: 0 },
        }),
        makeSettings(),
      );
    expect(songOf(rated(0), videoId(1)).flaggerIds).toEqual([
      id(2),
      id(3),
      id(4),
    ]);
    const switched = songOf(rated(7), videoId(1));
    expect(switched.flaggerIds).toEqual([id(2), id(4)]);
    expect(switched).toMatchObject({ scoreTenths: 23, genreFailed: true });
    const both = songOf(
      scoreRound(
        roundWith(songs, {
          [id(2)]: { [videoId(1)]: 7 },
          [id(3)]: { [videoId(1)]: 7 },
          [id(4)]: { [videoId(1)]: 0 },
        }),
        makeSettings(),
      ),
      videoId(1),
    );
    expect(both.flaggerIds).toEqual([id(4)]);
    expect(both.genreFailed).toBe(false);
  });

  it('halves linked points with ceiling, the bonus included', () => {
    const songs: Song[] = [
      {
        media: media(videoId(1)),
        memberVideoIds: [videoId(1)],
        ownerIds: [id(1)],
        clipSeconds: 20,
      },
      {
        media: media(videoId(2)),
        memberVideoIds: [videoId(2)],
        ownerIds: [id(2)],
        clipSeconds: 20,
      },
    ];
    const ratings = {
      [id(2)]: { [videoId(1)]: 7 },
      [id(3)]: { [videoId(1)]: 7, [videoId(2)]: 5 },
      [id(4)]: { [videoId(1)]: 8, [videoId(2)]: 5 },
    };
    const full = scoreRound(
      roundWith(songs, ratings, [id(1), id(2), id(3), id(4)]),
      makeSettings(),
    );
    expect(songOf(full, videoId(1))).toMatchObject({
      scoreTenths: 73,
      winner: true,
      bonus: 20,
    });
    expect(full.playerDeltas[id(1)]).toBe(93);
    const half = scoreRound(
      roundWith(songs, ratings, [id(1), id(2), id(3), id(4)]),
      makeSettings({ linkedPoints: 'halfCeil' }),
    );
    // ceil((73 + 20) / 2) = ceil(46.5) = 47
    expect(half.playerDeltas[id(1)]).toBe(47);
    // The non-winner 5.0 halves without a bonus: ceil(50 / 2) = 25.
    expect(half.playerDeltas[id(2)]).toBe(25);
  });

  it('keeps the genre-fail penalty full in half-ceil mode', () => {
    const songs = songsFor([id(1), id(2)]);
    const result = scoreRound(
      roundWith(songs, {
        [id(2)]: { [videoId(1)]: 0 },
        [id(3)]: { [videoId(1)]: 0 },
        [id(4)]: { [videoId(1)]: 10 },
      }),
      makeSettings({ linkedPoints: 'halfCeil' }),
    );
    // (0 + 0 + 10) / 3 = 3.3; ceil(33 / 2) = 17, then the full 3.0 penalty -> -1.3.
    expect(result.playerDeltas[id(1)]).toBe(-13);
  });

  it('awards nothing in a round without songs', () => {
    const none = scoreRound(roundWith([], {}), makeSettings());
    expect(none).toMatchObject({ reason: 'noSongs', songs: [] });
    expect(Object.values(none.playerDeltas)).toEqual([0, 0, 0, 0]);
  });
});
