import { describe, expect, it } from 'vitest';
import type { GameState } from '../shared/game';
import {
  BANGER_REVEAL_MS,
  REVEAL_HOLD_MS,
  REVEAL_PER_SONG_MS,
  classifyCommand,
  revealSlots,
} from './reducer';
import {
  selectPlayback,
  selectRatingEntries,
  selectReveal,
  selectViewerChoices,
  selectViewerPermissions,
} from './selectors';
import {
  action,
  command,
  fireDeadline,
  id,
  lastSongState,
  media,
  playbackState,
  revealState,
  send,
  submissionState,
  validationError,
  videoId,
} from './fixtures';

/** The connection currently bound to a viewer, read from the engine state. */
function conn(state: GameState, viewerId: string): string | null {
  const player = state.players[viewerId];
  return player === undefined ? null : player.connectionId;
}

function currentVideoId(state: GameState): string {
  if (state.phase.type !== 'PLAYBACK') {
    throw new Error('not in playback');
  }
  return state.round!.playbackOrder[state.phase.index];
}

function ownersOf(state: GameState, video: string): string[] {
  return state.round!.songs.find((song) => song.media.videoId === video)!
    .ownerIds;
}

/** A participant who does not own the song and may rate it. */
function raterFor(state: GameState, video: string): string {
  const owners = ownersOf(state, video);
  const rater = state.round!.participantIds.find(
    (playerId) => !owners.includes(playerId),
  );
  if (!rater) {
    throw new Error(`no eligible rater for ${video}`);
  }
  return rater;
}

function rate(
  state: GameState,
  playerId: string,
  songId: string,
  value: number,
  at: number,
): GameState {
  return command(state, playerId, { type: 'RATE', songId, value }, at);
}

/** Test seam around `classifyCommand` that builds the wire-level command. */
function rateRejection(
  state: GameState,
  playerId: string,
  songId: string,
  value: number,
  at: number,
): string | null {
  return classifyCommand(
    state,
    action(
      state,
      { type: 'RATE', songId, value },
      {
        actorId: playerId,
        connectionId: state.players[playerId]?.connectionId ?? id(999),
        at,
      },
    ),
  );
}

/** Walks a PLAYBACK phase to its last song; every earlier song stays open. */
function toLastSong(state: GameState): GameState {
  const last = (state.round?.playbackOrder.length ?? 1) - 1;
  for (
    let step = 0;
    step < 20 && state.phase.type === 'PLAYBACK' && state.phase.index < last;
    step += 1
  ) {
    state = fireDeadline(state);
  }
  expect(state.phase.type).toBe('PLAYBACK');
  return state;
}

describe('rating during playback (FR-40)', () => {
  it('accepts a rating during the current song preroll', () => {
    const state = playbackState();
    const song = currentVideoId(state);
    const rater = raterFor(state, song);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.startAt - 1 : 0;
    const accepted = rate(state, rater, song, 7, at);
    expect(accepted).not.toBe(state);
    expect(accepted.round?.ratings[rater]?.[song]).toBe(7);
    expect(validationError(accepted)).toBeNull();
  });

  it('accepts a changed value and rejects an unchanged one as NOT_READY', () => {
    let state = playbackState();
    const song = currentVideoId(state);
    const rater = raterFor(state, song);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.startAt + 100 : 0;
    state = rate(state, rater, song, 5, at);
    expect(state.round?.ratings[rater]?.[song]).toBe(5);
    expect(rateRejection(state, rater, song, 5, at + 1)).toBe('NOT_READY');
    const changed = rate(state, rater, song, 7, at + 2);
    expect(changed.round?.ratings[rater]?.[song]).toBe(7);
  });

  it('keeps an earlier played song open until the phase ends', () => {
    const state = toLastSong(lastSongState());
    const played = state.round!.playbackOrder[0];
    const rater = raterFor(state, played);
    const deadline =
      state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt : 0;
    const accepted = rate(state, rater, played, 6, deadline - 1);
    expect(accepted.round?.ratings[rater]?.[played]).toBe(6);
  });

  it('rejects ratings while paused and outside PLAYBACK', () => {
    const playing = playbackState();
    const song = currentVideoId(playing);
    const rater = raterFor(playing, song);
    const paused = command(playing, id(1), { type: 'PAUSE' }, 7000);
    expect(rateRejection(paused, rater, song, 5, 7001)).toBe('WRONG_PHASE');
    expect(rate(paused, rater, song, 5, 7001)).toBe(paused);

    const submission = submissionState();
    expect(rateRejection(submission, id(1), videoId(2), 5, 4200)).toBe(
      'WRONG_PHASE',
    );
    const reveal = revealState();
    expect(rateRejection(reveal, id(1), videoId(2), 5, 95000)).toBe(
      'WRONG_PHASE',
    );
  });

  it('rejects a late rating once the reveal has started', () => {
    const state = lastSongState();
    const song = currentVideoId(state);
    const rater = raterFor(state, song);
    const revealed = fireDeadline(state);
    expect(revealed.phase.type).toBe('REVEAL');
    const at =
      revealed.phase.type === 'REVEAL' ? revealed.phase.startedAt + 1 : 0;
    expect(rateRejection(revealed, rater, song, 5, at)).toBe('WRONG_PHASE');
  });

  it('rejects non-participants', () => {
    const playing = playbackState();
    const song = currentVideoId(playing);
    const spectator = send(
      playing,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 7100 },
    );
    expect(spectator.players[id(9)].status).toBe('spectator');
    expect(rateRejection(spectator, id(9), song, 5, 7101)).toBe('FORBIDDEN');
  });

  it('rejects the owner, an unknown or a not yet started song', () => {
    const open = toLastSong(lastSongState());
    const own = videoId(1);
    const owner = ownersOf(open, own)[0];
    expect(rateRejection(open, owner, own, 5, 1)).toBe('INVALID');
    const rater = raterFor(open, own);
    expect(rateRejection(open, rater, videoId(9), 5, 1)).toBe('INVALID');
    const first = playbackState();
    const notStarted = first.round!.playbackOrder[1];
    const early = raterFor(first, notStarted);
    if (first.phase.type === 'PLAYBACK') {
      expect(
        rateRejection(first, early, notStarted, 5, first.phase.startAt),
      ).toBe('INVALID');
    }
  });

  it('rejects out-of-range and non-integer values', () => {
    const state = playbackState();
    const song = currentVideoId(state);
    const rater = raterFor(state, song);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.startAt : 0;
    for (const value of [-1, 11, 1.5, 0.5]) {
      expect(rateRejection(state, rater, song, value, at)).toBe('INVALID');
    }
    // The 0 and 10 boundaries are valid.
    expect(rate(state, rater, song, 0, at).round?.ratings[rater]?.[song]).toBe(
      0,
    );
    expect(rate(state, rater, song, 10, at).round?.ratings[rater]?.[song]).toBe(
      10,
    );
  });
});

describe('rating selectors', () => {
  it('exposes the own rating and the rate permission per viewer', () => {
    let state = toLastSong(lastSongState());
    const song = currentVideoId(state);
    const owners = ownersOf(state, song);
    const owner = owners[0];
    const rater = raterFor(state, song);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    state = rate(state, rater, song, 8, at);

    const ownerView = selectPlayback(state, owner, conn(state, owner));
    expect(ownerView).toMatchObject({ rating: null, canRate: false });
    const raterView = selectPlayback(state, rater, conn(state, rater));
    expect(raterView).toMatchObject({ rating: 8, canRate: true });
    expect(raterView?.song.videoId).toBe(song);

    expect(
      selectViewerPermissions(state, rater, conn(state, rater)).canRate,
    ).toBe(true);
    // The permission is the phase-level hint: an owner keeps it, the per-song
    // `canRate` on the playback view above is what says "your song".
    expect(
      selectViewerPermissions(state, owner, conn(state, owner)).canRate,
    ).toBe(true);
  });

  it('reports the unrated current song and lists current plus earlier songs', () => {
    const first = playbackState();
    const song = currentVideoId(first);
    const rater = raterFor(first, song);
    const entries = selectRatingEntries(first, rater, conn(first, rater));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      videoId: song,
      index: 0,
      isCurrent: true,
      ownedByViewer: false,
      rating: null,
      canRate: true,
    });
    const owner = ownersOf(first, song)[0];
    expect(
      selectRatingEntries(first, owner, conn(first, owner))[0],
    ).toMatchObject({ ownedByViewer: true, canRate: false });

    const last = toLastSong(lastSongState());
    const all = selectRatingEntries(
      last,
      raterFor(last, currentVideoId(last)),
      conn(last, id(2)),
    );
    expect(all).toHaveLength(4);
    expect(all[3].isCurrent).toBe(true);
    expect(all.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
  });

  it('never leaks another player rating through the viewer choices', () => {
    let state = toLastSong(lastSongState());
    const song = currentVideoId(state);
    const owners = ownersOf(state, song);
    const owner = owners[0];
    const rater = raterFor(state, song);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    state = rate(state, rater, song, 9, at);
    expect(selectViewerChoices(state, rater).ratings).toEqual({ [song]: 9 });
    expect(selectViewerChoices(state, owner).ratings).toEqual({});
  });

  it('returns empty rating views outside PLAYBACK', () => {
    const reveal = revealState();
    expect(selectRatingEntries(reveal, id(1), conn(reveal, id(1)))).toEqual([]);
    expect(selectPlayback(reveal, id(1), conn(reveal, id(1)))).toBeNull();
    const submission = submissionState();
    expect(
      selectRatingEntries(submission, id(1), conn(submission, id(1))),
    ).toEqual([]);
    expect(
      selectViewerPermissions(submission, id(1), conn(submission, id(1)))
        .canRate,
    ).toBe(false);
  });
});

describe('rating scoring integration', () => {
  it('scores and reveals four rated songs with a banger winner', () => {
    let state = toLastSong(lastSongState());
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    // Song 1 (owner id1) is a banger: every rating a 10.
    state = rate(state, id(2), videoId(1), 10, at);
    state = rate(state, id(3), videoId(1), 10, at);
    state = rate(state, id(4), videoId(1), 10, at);
    // Song 2 (owner id2) 5.0, song 3 (owner id3) 6.0, song 4 (owner id4) 7.0.
    for (const playerId of [id(1), id(3), id(4)]) {
      state = rate(state, playerId, videoId(2), 5, at);
    }
    for (const playerId of [id(1), id(2), id(4)]) {
      state = rate(state, playerId, videoId(3), 6, at);
    }
    for (const playerId of [id(1), id(2), id(3)]) {
      state = rate(state, playerId, videoId(4), 7, at);
    }
    const revealed = fireDeadline(state);
    expect(revealed.phase.type).toBe('REVEAL');
    const result = revealed.results[0];
    expect(result.reason).toBe('normal');
    expect(result.playerDeltas).toEqual({
      [id(1)]: 120,
      [id(2)]: 50,
      [id(3)]: 60,
      [id(4)]: 70,
    });
    const banger = result.songs.find(
      (scored) => scored.song.media.videoId === videoId(1),
    );
    expect(banger).toMatchObject({
      scoreTenths: 100,
      ratingCount: 3,
      banger: true,
      basis: 'ratings',
      winner: true,
      bonus: 20,
    });
    expect(revealed.players[id(1)].totalScore).toBe(120);

    const view = selectReveal(revealed);
    expect(view).not.toBeNull();
    expect(view?.entries.map((entry) => entry.videoId)).toEqual([
      videoId(2),
      videoId(3),
      videoId(4),
      videoId(1),
    ]);
    expect(view?.entries.map((entry) => entry.scoreTenths)).toEqual([
      50, 60, 70, 100,
    ]);
    expect(view?.entries.map((entry) => entry.slotMs)).toEqual([
      REVEAL_PER_SONG_MS,
      REVEAL_PER_SONG_MS,
      REVEAL_PER_SONG_MS,
      BANGER_REVEAL_MS,
    ]);
    const startedAt =
      revealed.phase.type === 'REVEAL' ? revealed.phase.startedAt : 0;
    expect(view?.entries.map((entry) => entry.revealAt)).toEqual([
      startedAt,
      startedAt + REVEAL_PER_SONG_MS,
      startedAt + 2 * REVEAL_PER_SONG_MS,
      startedAt + 3 * REVEAL_PER_SONG_MS,
    ]);
    expect(
      revealed.phase.type === 'REVEAL' ? revealed.phase.deadlineAt : 0,
    ).toBe(
      startedAt + REVEAL_PER_SONG_MS * 3 + BANGER_REVEAL_MS + REVEAL_HOLD_MS,
    );
    expect(view?.entries.map((entry) => entry.bangerShow)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(revealSlots([{ banger: true }])).toEqual([
      { slotMs: BANGER_REVEAL_MS, bangerShow: true },
    ]);
    expect(revealSlots([{ banger: false }])).toEqual([
      { slotMs: REVEAL_PER_SONG_MS, bangerShow: false },
    ]);
    expect(validationError(revealed)).toBeNull();
  });

  it('gives only the first banger of a round the banger slot', () => {
    let state = toLastSong(lastSongState());
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    // Songs 1 (owner id1) and 2 (owner id2) are bangers: every rating a 10.
    for (const playerId of [id(2), id(3), id(4)]) {
      state = rate(state, playerId, videoId(1), 10, at);
    }
    for (const playerId of [id(1), id(3), id(4)]) {
      state = rate(state, playerId, videoId(2), 10, at);
    }
    for (const playerId of [id(1), id(2), id(4)]) {
      state = rate(state, playerId, videoId(3), 6, at);
    }
    for (const playerId of [id(1), id(2), id(3)]) {
      state = rate(state, playerId, videoId(4), 7, at);
    }
    const revealed = fireDeadline(state);
    expect(revealed.phase.type).toBe('REVEAL');
    const view = selectReveal(revealed);
    expect(view?.entries.map((entry) => entry.banger)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // Worst first; the first banger owns the stage for 5 s, the second banger
    // keeps its flag but runs a normal slot.
    expect(view?.entries.map((entry) => entry.slotMs)).toEqual([
      REVEAL_PER_SONG_MS,
      REVEAL_PER_SONG_MS,
      BANGER_REVEAL_MS,
      REVEAL_PER_SONG_MS,
    ]);
    expect(view?.entries.map((entry) => entry.bangerShow)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    const startedAt =
      revealed.phase.type === 'REVEAL' ? revealed.phase.startedAt : 0;
    expect(view?.entries.map((entry) => entry.revealAt)).toEqual([
      startedAt,
      startedAt + REVEAL_PER_SONG_MS,
      startedAt + 2 * REVEAL_PER_SONG_MS,
      startedAt + 2 * REVEAL_PER_SONG_MS + BANGER_REVEAL_MS,
    ]);
    expect(
      revealed.phase.type === 'REVEAL' ? revealed.phase.deadlineAt : 0,
    ).toBe(
      startedAt + REVEAL_PER_SONG_MS * 3 + BANGER_REVEAL_MS + REVEAL_HOLD_MS,
    );
    expect(
      revealSlots([
        { banger: false },
        { banger: true },
        { banger: true },
        { banger: true },
      ]).map((slot) => slot.bangerShow),
    ).toEqual([false, true, false, false]);
    expect(validationError(revealed)).toBeNull();
  });

  it('scores the remaining songs when one of three players skips', () => {
    let state = fireDeadline(submissionState(3), 4000);
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
    state = command(state, id(3), { type: 'FINISH_SUBMISSION' }, 4102);
    state = command(state, id(1), { type: 'FINISH_SUBMISSION' }, 4103);
    state = command(state, id(2), { type: 'FINISH_SUBMISSION' }, 4104);
    expect(state.phase.type).toBe('PLAYBACK');
    expect(state.round?.playbackOrder).toHaveLength(2);
    state = toLastSong(state);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    state = rate(state, id(2), videoId(1), 10, at);
    state = rate(state, id(3), videoId(1), 8, at);
    state = rate(state, id(1), videoId(2), 6, at);
    state = rate(state, id(3), videoId(2), 4, at);
    const revealed = fireDeadline(state);
    const result = revealed.results[0];
    expect(result.reason).toBe('normal');
    expect(result.songs).toHaveLength(2);
    expect(result.playerDeltas).toEqual({
      [id(1)]: 110,
      [id(2)]: 50,
      [id(3)]: 0,
    });
    const winner = result.songs.find(
      (scored) => scored.song.media.videoId === videoId(1),
    );
    expect(winner).toMatchObject({
      scoreTenths: 90,
      ratingCount: 2,
      basis: 'ratings',
      winner: true,
      bonus: 20,
    });
    expect(validationError(revealed)).toBeNull();
  });

  it('rates a single-song round normally instead of skipping it', () => {
    let state = fireDeadline(submissionState(3), 4000);
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(1)) },
      4100,
    );
    state = command(state, id(1), { type: 'FINISH_SUBMISSION' }, 4101);
    state = command(state, id(2), { type: 'FINISH_SUBMISSION' }, 4102);
    state = command(state, id(3), { type: 'FINISH_SUBMISSION' }, 4103);
    expect(state.phase.type).toBe('PLAYBACK');
    expect(state.round?.playbackOrder).toEqual([videoId(1)]);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    state = rate(state, id(2), videoId(1), 7, at);
    state = rate(state, id(3), videoId(1), 8, at);
    const revealed = fireDeadline(state);
    const result = revealed.results[0];
    expect(result.reason).toBe('normal');
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0]).toMatchObject({
      scoreTenths: 75,
      ratingCount: 2,
      basis: 'ratings',
      winner: true,
      bonus: 20,
    });
    expect(result.playerDeltas[id(1)]).toBe(95);
    expect(validationError(revealed)).toBeNull();
  });

  it('gives 5.0 to every owner when nobody may rate the song', () => {
    let state = fireDeadline(submissionState(3), 4000);
    for (const playerId of [id(1), id(2), id(3)]) {
      state = command(
        state,
        playerId,
        { type: 'SUBMIT_SONG', media: media(videoId(1)) },
        4100,
      );
      state = command(state, playerId, { type: 'FINISH_SUBMISSION' }, 4200);
    }
    expect(state.phase.type).toBe('PLAYBACK');
    expect(state.round?.playbackOrder).toEqual([videoId(1)]);
    expect(state.round?.songs[0].ownerIds).toEqual([id(1), id(2), id(3)]);
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
    expect(rateRejection(state, id(1), videoId(1), 5, at)).toBe('INVALID');
    const revealed = fireDeadline(state);
    const result = revealed.results[0];
    expect(result.songs[0]).toMatchObject({
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
    expect(validationError(revealed)).toBeNull();
  });

  it('skips a round only when no song was submitted', () => {
    const revealed = revealState();
    expect(revealed.phase.type).toBe('REVEAL');
    expect(revealed.results[0].reason).toBe('noSongs');
    expect(revealed.results[0].songs).toEqual([]);
    expect(Object.values(revealed.results[0].playerDeltas)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(validationError(revealed)).toBeNull();
  });
});
