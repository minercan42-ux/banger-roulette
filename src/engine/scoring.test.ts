import { describe, expect, it } from 'vitest';
import type { Round, Song } from '../shared/game';
import { scoreRound } from './scoring';
import { genre, id, makeSettings, media, videoId } from './fixtures';

function songsFor(owners: string[]): Song[] {
  const songs: Song[] = [];
  owners.forEach((ownerId, index) => {
    songs.push({
      media: media(videoId(index + 1)),
      ownerIds: [ownerId],
      clipSeconds: 20,
    });
  });
  return songs;
}

function roundWith(
  songs: Song[],
  ballots: Record<string, string[]>,
  flags: Record<string, string[]> = {},
): Round {
  const ballotsById: Round['ballots'] = {};
  for (const [playerId, ranking] of Object.entries(ballots)) {
    ballotsById[playerId] = { ranking };
  }
  return {
    number: 1,
    genre: genre(0),
    participantIds: [id(1), id(2), id(3), id(4)],
    submissions: {},
    submissionDoneIds: [],
    nextSubmissionOrder: songs.length,
    songs,
    playbackOrder: songs.map((song) => song.media.videoId),
    ballots: ballotsById,
    votingDoneIds: [],
    genreFailFlags: flags,
  };
}

const owners = [id(1), id(2), id(3), id(4)];

describe('scoreRound', () => {
  it('reproduces AK-8 exactly', () => {
    const songs = songsFor(owners);
    const ballots = {
      [id(1)]: [videoId(3), videoId(2), videoId(4)],
      [id(2)]: [videoId(3), videoId(1), videoId(4)],
      [id(3)]: [videoId(1), videoId(2), videoId(4)],
      [id(4)]: [videoId(3), videoId(1), videoId(2)],
    };
    const result = scoreRound(roundWith(songs, ballots), makeSettings());
    expect(result.reason).toBe('normal');
    expect(result.playerDeltas).toEqual({
      [id(1)]: 7,
      [id(2)]: 5,
      [id(3)]: 11,
      [id(4)]: 3,
    });
    expect(
      result.songs.find((scored) => scored.song.media.videoId === videoId(3)),
    ).toMatchObject({ borda: 9, bonus: 2, winner: true, genreFailed: false });
    expect(
      result.songs.find((scored) => scored.song.media.videoId === videoId(2)),
    ).toMatchObject({ borda: 5, bonus: 0, winner: false });
  });

  it('counts only the songs a player actually ranked', () => {
    const songs = songsFor([id(1), id(2), id(3)]);
    const result = scoreRound(
      roundWith(songs, { [id(1)]: [videoId(2), videoId(3)] }),
      makeSettings(),
    );
    expect(
      result.songs.find((scored) => scored.song.media.videoId === videoId(2)),
    ).toMatchObject({ borda: 2, winner: true });
    expect(
      result.songs.find((scored) => scored.song.media.videoId === videoId(3)),
    ).toMatchObject({ borda: 1, winner: false });
    expect(
      result.songs.find((scored) => scored.song.media.videoId === videoId(1)),
    ).toMatchObject({ borda: 0, winner: false });
  });

  it('halves linked points with ceiling and keeps the penalty full', () => {
    const songs: Song[] = [
      { media: media(videoId(1)), ownerIds: [id(1)], clipSeconds: 20 },
      { media: media(videoId(2)), ownerIds: [id(2)], clipSeconds: 20 },
      { media: media(videoId(3)), ownerIds: [id(3)], clipSeconds: 20 },
      { media: media(videoId(4)), ownerIds: [id(4)], clipSeconds: 20 },
    ];
    const ballots = {
      [id(2)]: [videoId(1), videoId(3), videoId(4)],
      [id(3)]: [videoId(1), videoId(4)],
    };
    const full = scoreRound(roundWith(songs, ballots), makeSettings());
    expect(
      full.songs.find((scored) => scored.song.media.videoId === videoId(1)),
    ).toMatchObject({ borda: 5, bonus: 2, winner: true });
    expect(full.playerDeltas[id(1)]).toBe(7);
    const half = scoreRound(
      roundWith(songs, ballots),
      makeSettings({ linkedPoints: 'halfCeil' }),
    );
    expect(half.playerDeltas[id(1)]).toBe(4);
    const failed = scoreRound(
      roundWith(songs, ballots, {
        [id(2)]: [videoId(1)],
        [id(3)]: [videoId(1)],
        [id(4)]: [videoId(1)],
      }),
      makeSettings({ linkedPoints: 'halfCeil' }),
    );
    expect(
      failed.songs.find((scored) => scored.song.media.videoId === videoId(1)),
    ).toMatchObject({ genreFailed: true, bonus: 0, winner: false });
    expect(failed.playerDeltas[id(1)]).toBe(0);
  });

  it('requires more than half of the eligible voters to flag', () => {
    const songs = songsFor(owners);
    const ballots = {
      [id(1)]: [videoId(2), videoId(3), videoId(4)],
      [id(2)]: [videoId(1), videoId(3), videoId(4)],
      [id(3)]: [videoId(1), videoId(2), videoId(4)],
      [id(4)]: [videoId(1), videoId(2), videoId(3)],
    };
    const two = scoreRound(
      {
        ...roundWith(songs, ballots, {
          [id(1)]: [videoId(3)],
          [id(2)]: [videoId(3)],
        }),
        participantIds: [...owners, id(5)],
      },
      makeSettings(),
    );
    expect(
      two.songs.find((scored) => scored.song.media.videoId === videoId(3)),
    ).toMatchObject({ genreFailed: false, flaggerIds: [id(1), id(2)] });
    const three = scoreRound(
      {
        ...roundWith(songs, ballots, {
          [id(1)]: [videoId(3)],
          [id(2)]: [videoId(3)],
          [id(4)]: [videoId(3)],
        }),
        participantIds: [...owners, id(5)],
      },
      makeSettings(),
    );
    const flagged = three.songs.find(
      (scored) => scored.song.media.videoId === videoId(3),
    );
    expect(flagged).toMatchObject({
      genreFailed: true,
      winner: false,
      bonus: 0,
    });
    expect(flagged?.ownerDeltas[id(3)]).toBe(
      (flagged?.borda ?? 0) + makeSettings().genreFailPenalty,
    );
  });

  it('awards nothing in degenerate rounds', () => {
    const none = scoreRound(roundWith([], {}), makeSettings());
    expect(none).toMatchObject({ reason: 'noSongs', songs: [] });
    expect(Object.values(none.playerDeltas)).toEqual([0, 0, 0, 0]);
    const single = scoreRound(
      roundWith(songsFor([id(1), id(2)]).slice(0, 1), {
        [id(2)]: [videoId(1)],
      }),
      makeSettings(),
    );
    expect(single.reason).toBe('singleSong');
    expect(single.songs[0]).toMatchObject({
      borda: 0,
      bonus: 0,
      winner: false,
    });
    expect(single.songs[0].ownerDeltas[id(1)]).toBe(0);
    expect(Object.values(single.playerDeltas)).toEqual([0, 0, 0, 0]);
  });

  it('shares the winner bonus between every song tied at zero', () => {
    const songs = songsFor(owners);
    const result = scoreRound(roundWith(songs, {}), makeSettings());
    expect(result.reason).toBe('normal');
    for (const scored of result.songs) {
      expect(scored).toMatchObject({ borda: 0, bonus: 2, winner: true });
      expect(scored.ownerDeltas[scored.song.ownerIds[0]]).toBe(2);
    }
    expect(result.playerDeltas).toEqual({
      [id(1)]: 2,
      [id(2)]: 2,
      [id(3)]: 2,
      [id(4)]: 2,
    });
  });

  it('excludes every song from the bonus once all of them failed', () => {
    const songs = songsFor(owners);
    const ballots = {
      [id(1)]: [videoId(2), videoId(3), videoId(4)],
      [id(2)]: [videoId(1), videoId(3), videoId(4)],
      [id(3)]: [videoId(1), videoId(2), videoId(4)],
      [id(4)]: [videoId(1), videoId(2), videoId(3)],
    };
    const flags = {
      [id(1)]: [videoId(2), videoId(3), videoId(4)],
      [id(2)]: [videoId(1), videoId(3), videoId(4)],
      [id(3)]: [videoId(1), videoId(2), videoId(4)],
      [id(4)]: [videoId(1), videoId(2), videoId(3)],
    };
    const result = scoreRound(
      roundWith(songs, ballots, flags),
      makeSettings({ genreFailPenalty: 0 }),
    );
    for (const scored of result.songs) {
      expect(scored).toMatchObject({
        genreFailed: true,
        winner: false,
        bonus: 0,
      });
    }
    // zero penalty keeps the Borda points but never restores the bonus
    expect(result.playerDeltas).toEqual({
      [id(1)]: 9,
      [id(2)]: 7,
      [id(3)]: 5,
      [id(4)]: 3,
    });
  });

  it('subtracts the full negative penalty in full linked mode', () => {
    const songs = songsFor(owners);
    const ballots = {
      [id(2)]: [videoId(1), videoId(3), videoId(4)],
      [id(3)]: [videoId(1), videoId(4)],
    };
    const result = scoreRound(
      roundWith(songs, ballots, {
        [id(2)]: [videoId(1)],
        [id(3)]: [videoId(1)],
        [id(4)]: [videoId(1)],
      }),
      makeSettings({ linkedPoints: 'full' }),
    );
    const flagged = result.songs.find(
      (scored) => scored.song.media.videoId === videoId(1),
    );
    expect(flagged).toMatchObject({
      genreFailed: true,
      winner: false,
      bonus: 0,
      borda: 5,
    });
    expect(flagged?.ownerDeltas[id(1)]).toBe(2);
  });
});
