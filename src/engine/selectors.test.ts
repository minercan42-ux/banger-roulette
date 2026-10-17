import { describe, expect, it } from 'vitest';
import type { GameState } from '../shared/game';
import {
  REVEAL_PER_SONG_MS,
  SPIN_MS,
  classifyCommand,
  reducer,
} from './reducer';
import {
  areOwnersVisible,
  selectCurrentSong,
  selectFinal,
  selectGenrePool,
  selectLobbyReadiness,
  selectPhaseTimer,
  selectPlayback,
  selectResults,
  selectReveal,
  selectRoster,
  selectRound,
  selectRoom,
  selectSettings,
  selectSongs,
  selectStandings,
  selectViewerChoices,
  selectRatingEntries,
  selectViewerPermissions,
} from './selectors';
import {
  GAME_START,
  SPIN_END,
  SUBMISSION_END,
  action,
  command,
  finalState,
  fireDeadline,
  genre,
  id,
  makeSettings,
  media,
  newGame,
  lastSongState,
  playbackState,
  presence,
  revealState,
  scoredFinalState,
  send,
  startedGame,
  submissionState,
  validationError,
  videoId,
} from './fixtures';

function collectKeys(value: unknown, keys: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

/** The connection currently bound to a viewer, read from the engine state. */
function conn(state: GameState, viewerId: string): string | null {
  const player = state.players[viewerId];
  return player === undefined ? null : player.connectionId;
}

/** Reveal built from live ratings: 40 / 50 / 60, winner song 1 at 85 + 2.0. */
function scoredReveal() {
  let state = lastSongState();
  const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 1 : 0;
  const given: [number, number, number][] = [
    [2, 1, 8],
    [3, 1, 9],
    [1, 2, 5],
    [3, 2, 5],
    [1, 3, 6],
    [2, 3, 6],
    [1, 4, 4],
    [2, 4, 4],
  ];
  for (const [rater, song, value] of given) {
    state = command(
      state,
      id(rater),
      { type: 'RATE', songId: videoId(song), value },
      at,
    );
  }
  return fireDeadline(state);
}

describe('selectRoom', () => {
  it('describes the room without protocol metadata', () => {
    const state = playbackState();
    expect(selectRoom(state)).toEqual({
      roomCode: 'ABCDEF',
      gameNumber: 1,
      hostId: id(1),
      phase: 'PLAYBACK',
      paused: false,
      pauseReason: null,
      anonymous: true,
      ownersVisible: false,
      roundNumber: 1,
      genre: state.round?.genre,
      totalRounds: 5,
    });
  });
});

describe('lobby settings reads', () => {
  it('reflects mode changes and isolates the returned payloads', () => {
    const lobby = newGame();
    expect(selectSettings(lobby)).toEqual({
      genreMode: 'roulette',
      rounds: 5,
      submissionSeconds: 90,
      clipSeconds: 40,
      anonymous: true,
      genreFailPenalty: -3,
      linkedPoints: 'full',
      customItems: [],
      fixedGenre: null,
    });
    expect(selectGenrePool(lobby)).toHaveLength(30);
    const custom = command(
      lobby,
      lobby.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({
          genre: { mode: 'custom', items: [genre(2), genre(1)] },
          rounds: 3,
          linkedPoints: 'halfCeil',
        }),
      },
      100,
    );
    const customView = selectSettings(custom);
    expect(customView).toMatchObject({
      genreMode: 'custom',
      rounds: 3,
      linkedPoints: 'halfCeil',
      customItems: [genre(2), genre(1)],
      fixedGenre: null,
    });
    expect(selectGenrePool(custom).map((entry) => entry.id)).toEqual([
      'g2',
      'g1',
    ]);
    customView.customItems.push(genre(9));
    expect(selectSettings(custom).customItems).toEqual([genre(2), genre(1)]);
    const fixed = command(
      custom,
      custom.hostId,
      {
        type: 'SET_SETTINGS',
        settings: makeSettings({ genre: { mode: 'fixed', genre: genre(4) } }),
      },
      200,
    );
    const fixedView = selectSettings(fixed);
    expect(fixedView).toMatchObject({
      genreMode: 'fixed',
      rounds: 5,
      customItems: [],
      fixedGenre: genre(4),
    });
    expect(selectGenrePool(fixed)).toEqual([genre(4)]);
    fixedView.rounds = 99;
    if (fixedView.fixedGenre) {
      fixedView.fixedGenre.en = 'Mutated';
    }
    expect(selectSettings(fixed)).toMatchObject({
      rounds: 5,
      fixedGenre: genre(4),
    });
    const pool = selectGenrePool(fixed);
    pool[0].de = 'Mutated';
    expect(selectGenrePool(fixed)).toEqual([genre(4)]);
    expect(validationError(fixed)).toBeNull();
  });
});

describe('selectPhaseTimer', () => {
  it('derives remaining time and freezes it while paused', () => {
    const state = startedGame();
    expect(selectPhaseTimer(state, GAME_START)).toEqual({
      phase: 'GENRE_SPIN',
      deadlineAt: SPIN_END,
      totalMs: SPIN_MS,
      remainingMs: SPIN_MS,
      paused: false,
    });
    expect(selectPhaseTimer(state, 9000).remainingMs).toBe(0);
    const paused = command(state, id(1), { type: 'PAUSE' }, 2000);
    expect(selectPhaseTimer(paused, 9500)).toEqual({
      phase: 'GENRE_SPIN',
      deadlineAt: SPIN_END,
      totalMs: SPIN_MS,
      remainingMs: SPIN_END - 2000,
      paused: true,
    });
    expect(selectPhaseTimer(newGame(), 0)).toEqual({
      phase: 'LOBBY',
      deadlineAt: null,
      totalMs: null,
      remainingMs: null,
      paused: false,
    });
    expect(selectPhaseTimer(submissionState(), 4000).totalMs).toBe(90000);
    expect(selectPhaseTimer(playbackState(), 7203).totalMs).toBe(40000);
    expect(selectPhaseTimer(revealState(), 94000).totalMs).toBe(5000);
  });
});

describe('selectLobbyReadiness', () => {
  it('reports players and sound unlock state', () => {
    expect(selectLobbyReadiness(newGame({ players: 2 }))).toMatchObject({
      connectedPlayers: 2,
      ready: false,
    });
    const locked = newGame({ sound: false });
    expect(selectLobbyReadiness(locked)).toMatchObject({
      connectedPlayers: 4,
      ready: false,
    });
    expect(selectLobbyReadiness(locked).soundLockedIds).toHaveLength(4);
    expect(selectLobbyReadiness(newGame())).toEqual({
      connectedPlayers: 4,
      minPlayers: 3,
      maxPlayers: 10,
      soundLockedIds: [],
      ready: true,
    });
  });
});

describe('selectRoster', () => {
  it('keeps departed players and marks roles without connection ids', () => {
    let state = submissionState();
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      4100,
    );
    state = command(state, id(2), { type: 'FINISH_SUBMISSION' }, 4101);
    state = command(state, id(3), { type: 'LEAVE' }, 4102);
    state = send(
      state,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 4300 },
    );
    const roster = selectRoster(state, id(1));
    expect(roster.map((player) => player.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
      id(9),
    ]);
    expect(roster[0]).toMatchObject({
      isHost: true,
      isSelf: true,
      status: 'player',
      isParticipant: true,
    });
    expect(roster[1]).toMatchObject({
      isHost: false,
      isSelf: false,
      submissionDone: true,
      isParticipant: true,
    });
    expect(roster[2]).toMatchObject({
      status: 'left',
      connected: false,
      isParticipant: true,
    });
    expect(roster[4]).toMatchObject({
      status: 'spectator',
      isParticipant: false,
    });
    expect(Object.keys(roster[0])).not.toContain('connectionId');
  });
});

describe('anonymity', () => {
  it('hides owners before the reveal and shows them after it', () => {
    const anonymous = playbackState();
    expect(areOwnersVisible(anonymous)).toBe(false);
    const current = selectCurrentSong(anonymous, id(1));
    expect(current?.ownersVisible).toBe(false);
    expect(current?.owners).toEqual([]);
    const own = selectSongs(anonymous, id(1)).find(
      (song) => song.videoId === videoId(1),
    );
    expect(own).toMatchObject({
      ownersVisible: false,
      owners: [],
      ownedByViewer: true,
      ownerCount: 1,
    });
    const foreign = selectSongs(anonymous, id(2)).find(
      (song) => song.videoId === videoId(1),
    );
    expect(foreign).toMatchObject({
      ownersVisible: false,
      ownedByViewer: false,
      owners: [],
    });
    expect(selectViewerChoices(anonymous, id(1)).media?.videoId).toBe(
      videoId(1),
    );
    const open = playbackState(4, makeSettings({ anonymous: false }));
    expect(areOwnersVisible(open)).toBe(true);
    const shown = selectSongs(open, id(2)).find(
      (song) => song.videoId === videoId(1),
    );
    expect(shown).toMatchObject({ ownersVisible: true, linked: false });
    expect(shown?.owners).toEqual([{ id: id(1), nickname: 'Host' }]);
    const reveal = scoredReveal();
    expect(areOwnersVisible(reveal)).toBe(true);
    expect(selectSongs(reveal, id(1))[0].ownersVisible).toBe(true);
  });

  it('exposes linked status without exposing anonymous owners', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(5)) },
      4101,
    );
    state = command(
      state,
      id(3),
      { type: 'SUBMIT_SONG', media: media(videoId(6)) },
      4102,
    );
    state = fireDeadline(state, SUBMISSION_END);
    const shared = selectSongs(state, id(4)).find(
      (song) => song.videoId === videoId(5),
    );
    expect(shared).toMatchObject({
      ownerCount: 2,
      ownersVisible: false,
      owners: [],
      linked: true,
      ownedByViewer: false,
    });
  });

  it('never exposes raw state, connection or cache fields', () => {
    const playing = playbackState();
    const reveal = revealState();
    const final = scoredFinalState();
    const keys = collectKeys(
      [
        selectRoom(playing),
        selectPhaseTimer(playing, 8000),
        selectLobbyReadiness(playing),
        selectRoster(playing, id(1)),
        selectRound(playing, id(1)),
        selectSongs(playing, id(1)),
        selectCurrentSong(playing, id(1)),
        selectRatingEntries(playing, id(1), conn(playing, id(1))),
        selectViewerChoices(playing, id(1)),
        selectViewerPermissions(playing, id(1), conn(playing, id(1))),
        selectReveal(reveal),
        selectResults(final),
        selectStandings(final, id(1)),
      ],
      new Set<string>(),
    );
    for (const forbidden of [
      'connectionId',
      'appliedCommandIds',
      'rngState',
      'hostEpoch',
      'hostBaseVersion',
      'stateVersion',
      'roomId',
      'remainingGenreIds',
      'forceBelowMinimum',
      'nextSubmissionOrder',
      'submissions',
    ]) {
      expect([...keys]).not.toContain(forbidden);
    }
    expect(selectRound(playing, id(1))).toMatchObject({
      playbackIndex: 0,
      currentVideoId: playing.round!.playbackOrder[0],
    });
  });
});

describe('selectViewerChoices', () => {
  it('isolates the viewer choices from everyone else', () => {
    let state = lastSongState();
    const at = state.phase.type === 'PLAYBACK' ? state.phase.deadlineAt - 3 : 0;
    state = command(
      state,
      id(1),
      { type: 'RATE', songId: videoId(2), value: 3 },
      at,
    );
    state = command(
      state,
      id(1),
      { type: 'RATE', songId: videoId(3), value: 0 },
      at + 1,
    );
    expect(selectViewerChoices(state, id(1))).toMatchObject({
      isParticipant: true,
      submitted: true,
      submissionDone: true,
      ratings: { [videoId(2)]: 3, [videoId(3)]: 0 },
    });
    expect(selectViewerChoices(state, id(1)).media?.videoId).toBe(videoId(1));
    expect(selectViewerChoices(state, id(2))).toMatchObject({ ratings: {} });
    expect(selectViewerChoices(state, id(2)).media?.videoId).toBe(videoId(2));
    expect(selectViewerChoices(state, id(9))).toEqual({
      isParticipant: false,
      submitted: false,
      submissionDone: false,
      media: null,
      ratings: {},
    });
  });
});

describe('selectRatingEntries', () => {
  it('lists the rating targets and excludes own songs', () => {
    const playing = playbackState();
    const ratings = selectRatingEntries(playing, id(1), conn(playing, id(1)));
    expect(ratings).toHaveLength(1);
    expect(
      ratings.every((entry) => entry.canRate === !entry.ownedByViewer),
    ).toBe(true);
    // A stranger gets the entries but may rate none of them.
    expect(
      selectRatingEntries(playing, id(9), conn(playing, id(9))).every(
        (entry) => !entry.canRate,
      ),
    ).toBe(true);
    expect(
      selectRatingEntries(submissionState(), id(1), conn(playing, id(1))),
    ).toEqual([]);
    // A genre-fail is the rating 0 and shows up as the viewer's own rating.
    const first = playing.round!.playbackOrder[0];
    const own = playing.round!.songs.find(
      (song) => song.media.videoId === first,
    )!.ownerIds[0];
    const viewer = playing.round!.participantIds.find((p) => p !== own)!;
    const zeroed = command(
      playing,
      viewer,
      { type: 'RATE', songId: first, value: 0 },
      8000,
    );
    expect(
      selectRatingEntries(zeroed, viewer, conn(zeroed, viewer))[0].rating,
    ).toBe(0);
    expect(selectPlayback(zeroed, viewer, conn(zeroed, viewer))?.rating).toBe(
      0,
    );
    expect(selectPlayback(zeroed, own, conn(zeroed, own))?.rating).toBeNull();
  });
});

describe('selectViewerPermissions', () => {
  it('maps phases and roles to display permissions', () => {
    const lobby = newGame();
    expect(
      selectViewerPermissions(lobby, id(1), conn(lobby, id(1))),
    ).toMatchObject({
      isHost: true,
      isParticipant: true,
      canStartGame: true,
      canEditSettings: true,
      canKick: true,
      canAdvance: false,
      canSubmit: false,
      canRematch: false,
    });
    expect(
      selectViewerPermissions(lobby, id(2), conn(lobby, id(2))),
    ).toMatchObject({
      isHost: false,
      canStartGame: false,
      canEditSettings: false,
      canKick: false,
    });
    const submission = submissionState();
    expect(
      selectViewerPermissions(submission, id(1), conn(submission, id(1))),
    ).toMatchObject({
      isParticipant: true,
      canSubmit: true,
      canFinishSubmission: true,
      canAdvance: true,
      canPause: true,
      canEndGame: true,
      canRate: false,
    });
    const lost = presence(submission, 4200, [id(101), id(103), id(104)]);
    expect(
      selectViewerPermissions(lost, id(2), conn(lost, id(2))),
    ).toMatchObject({
      isParticipant: true,
      canSubmit: false,
      canFinishSubmission: false,
    });
    const late = send(
      submission,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 4300 },
    );
    expect(
      selectViewerPermissions(late, id(9), conn(late, id(9))),
    ).toMatchObject({
      isParticipant: false,
      canSubmit: false,
    });
    const playing = playbackState();
    expect(
      selectViewerPermissions(playing, id(1), conn(playing, id(1))),
    ).toMatchObject({
      canSubmit: false,
      canRate: true,
      canAdvance: true,
    });
    const paused = command(playing, id(1), { type: 'PAUSE' }, 8000);
    expect(
      selectViewerPermissions(paused, id(1), conn(paused, id(1))),
    ).toMatchObject({
      canAdvance: false,
      canPause: false,
      canResume: true,
      canRate: false,
    });
    const final = scoredFinalState();
    expect(
      selectViewerPermissions(final, id(1), conn(final, id(1))),
    ).toMatchObject({
      canRematch: true,
      canEndGame: false,
      canPause: false,
    });
    const kicked = command(
      playing,
      id(1),
      { type: 'KICK', playerId: id(3) },
      8010,
    );
    expect(
      selectViewerPermissions(kicked, id(3), conn(kicked, id(3))),
    ).toMatchObject({
      isParticipant: true,
      isHost: false,
      canRate: false,
    });
    const unknown = selectViewerPermissions(playing, id(77), null);
    expect(unknown.isHost).toBe(false);
    expect(unknown.isParticipant).toBe(false);
    expect(
      Object.entries(unknown)
        .filter(([name]) => name.startsWith('can'))
        .every(([, granted]) => granted === false),
    ).toBe(true);
  });
});

describe('selectReveal and selectResults', () => {
  it('orders ascending score with deterministic ties and banger links', () => {
    const reveal = scoredReveal();
    const view = selectReveal(reveal);
    expect(view?.reason).toBe('normal');
    expect(view?.entries.map((entry) => entry.videoId)).toEqual([
      videoId(4),
      videoId(2),
      videoId(3),
      videoId(1),
    ]);
    expect(view?.entries[0]).toMatchObject({
      scoreTenths: 40,
      roundPoints: 40,
      bonus: 0,
      winner: false,
      genreFailed: false,
      ownerCount: 1,
      linked: false,
    });
    expect(view?.entries[3]).toMatchObject({
      scoreTenths: 85,
      bonus: 20,
      roundPoints: 105,
      winner: true,
    });
    expect(view?.entries[3].owners).toEqual([{ id: id(1), nickname: 'Host' }]);
    expect(view?.entries[3].watchUrl).toBe(
      `https://www.youtube.com/watch?v=${videoId(1)}&t=10s`,
    );
    const later = fireDeadline(reveal, 260000);
    expect(selectReveal(later)).toBeNull();
    expect(selectResults(later)).toHaveLength(1);
    expect(selectResults(later)[0].entries[3]).toMatchObject({
      winner: true,
      roundPoints: 105,
    });
  });

  it('omits the start offset from a banger link without a clip start', () => {
    let state = submissionState();
    state = command(
      state,
      id(1),
      {
        type: 'SUBMIT_SONG',
        media: media(videoId(1), { startSeconds: 0 }),
      },
      4100,
    );
    state = command(
      state,
      id(2),
      { type: 'SUBMIT_SONG', media: media(videoId(2)) },
      4101,
    );
    state = fireDeadline(state, SUBMISSION_END);
    state = fireDeadline(state, SUBMISSION_END + 43000);
    const reveal = fireDeadline(state, SUBMISSION_END + 86000);
    const entries = selectReveal(reveal)?.entries ?? [];
    expect(entries.map((entry) => entry.videoId)).toContain(videoId(1));
    for (const entry of entries) {
      const expected =
        entry.startSeconds > 0 ? `&t=${Math.floor(entry.startSeconds)}s` : '';
      expect(entry.watchUrl).toBe(
        `https://www.youtube.com/watch?v=${entry.videoId}${expected}`,
      );
    }
    expect(
      entries.find((entry) => entry.videoId === videoId(1))?.watchUrl,
    ).toBe(`https://www.youtube.com/watch?v=${videoId(1)}`);
    expect(
      entries.find((entry) => entry.videoId === videoId(2))?.watchUrl,
    ).toBe(`https://www.youtube.com/watch?v=${videoId(2)}&t=10s`);
  });

  it('keeps revealed results public after the anonymity phase', () => {
    const final = scoredFinalState();
    const results = selectResults(final);
    expect(results).toHaveLength(1);
    expect(results[0].roundNumber).toBe(1);
    expect(results[0].entries.map((entry) => entry.scoreTenths)).toEqual([
      45, 65, 85,
    ]);
    expect(results[0].entries[2]).toMatchObject({
      winner: true,
      roundPoints: 105,
    });
    expect(results[0].entries[2].owners).toEqual([
      { id: id(1), nickname: 'Host' },
    ]);
  });

  it('stages entries on server time, worst first', () => {
    const reveal = scoredReveal();
    const view = selectReveal(reveal);
    expect(view).not.toBeNull();
    expect(
      view?.entries.every((entry) => entry.slotMs === REVEAL_PER_SONG_MS),
    ).toBe(true);
    expect(view?.pausedAt).toBeNull();
    expect(view?.entries.map((entry) => entry.revealAt)).toEqual([
      view!.startedAt,
      view!.startedAt + REVEAL_PER_SONG_MS,
      view!.startedAt + 2 * REVEAL_PER_SONG_MS,
      view!.startedAt + 3 * REVEAL_PER_SONG_MS,
    ]);
    // Late joiners / reloads only see entries whose revealAt is in the past.
    const now = view!.startedAt + REVEAL_PER_SONG_MS + 1;
    expect(view!.entries.filter((entry) => entry.revealAt <= now)).toHaveLength(
      2,
    );
    // Pausing freezes the reveal reference at the pause instant.
    const paused = command(
      reveal,
      id(1),
      { type: 'PAUSE' },
      reveal.phase.type === 'REVEAL' ? reveal.phase.startedAt + 1 : 0,
    );
    expect(selectReveal(paused)?.pausedAt).toBe(
      paused.pause === null ? null : paused.pause.at,
    );
  });

  it('reports no entries and the phase reason for a noSongs round', () => {
    const reveal = revealState();
    const view = selectReveal(reveal);
    expect(view?.reason).toBe('noSongs');
    expect(view?.entries).toEqual([]);
  });
});

describe('selectFinal', () => {
  it('is null outside FINAL and exposes the finale reason', () => {
    expect(selectFinal(playbackState())).toBeNull();
    expect(selectFinal(scoredFinalState())).toEqual({ reason: 'completed' });
    expect(selectFinal(finalState())).toEqual({ reason: 'hostEnded' });
  });
});

describe('lobby selector edges', () => {
  it('exposes sound-write access only to the currently bound lobby tab', () => {
    const lobby = newGame();
    const rebound = send(
      lobby,
      { type: 'JOIN', nickname: 'Reconnect' },
      { actorId: id(2), connectionId: id(777), at: 10 },
    );
    expect(selectViewerPermissions(rebound, id(2), id(777))).toMatchObject({
      canWrite: true,
      canEditSettings: false,
    });
    expect(selectViewerPermissions(rebound, id(2), id(102)).canWrite).toBe(
      false,
    );
    expect(selectViewerPermissions(rebound, id(2), null).canWrite).toBe(false);
    const staleSound = action(
      rebound,
      { type: 'SOUND_STATUS', unlocked: true },
      { actorId: id(2), connectionId: id(102), at: 11 },
    );
    expect(classifyCommand(rebound, staleSound)).toBe('STALE');
    expect(reducer(rebound, staleSound)).toBe(rebound);
  });

  it('returns empty views before the first round exists', () => {
    const lobby = newGame();
    expect(selectRound(lobby, id(1))).toBeNull();
    expect(selectSongs(lobby, id(1))).toEqual([]);
    expect(selectCurrentSong(lobby, id(1))).toBeNull();
    expect(selectRatingEntries(lobby, id(1), conn(lobby, id(1)))).toEqual([]);
    expect(selectReveal(lobby)).toBeNull();
    expect(selectResults(lobby)).toEqual([]);
    expect(selectStandings(lobby, id(1)).map((entry) => entry.rank)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(selectViewerChoices(lobby, id(1))).toEqual({
      isParticipant: false,
      submitted: false,
      submissionDone: false,
      media: null,
      ratings: {},
    });
    expect(
      selectViewerPermissions(lobby, id(1), conn(lobby, id(1))),
    ).toMatchObject({
      isHost: true,
      canStartGame: true,
      canSubmit: false,
    });
    expect(selectRoom(lobby)).toMatchObject({
      phase: 'LOBBY',
      roundNumber: null,
      genre: null,
      ownersVisible: false,
    });
  });
});

describe('rating targets and bound tabs', () => {
  it('keeps rating targets and permissions aligned', () => {
    const base = playbackState();
    const late = send(
      base,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 8000 },
    );
    const cases: [string, GameState, string][] = [
      ['paused', command(base, id(1), { type: 'PAUSE' }, 8000), id(2)],
      [
        'disconnected',
        presence(base, 8000, [id(101), id(103), id(104)]),
        id(2),
      ],
      ['left', command(base, id(2), { type: 'LEAVE' }, 8000), id(2)],
      [
        'kicked',
        command(base, id(1), { type: 'KICK', playerId: id(2) }, 8000),
        id(2),
      ],
      ['spectator', late, id(9)],
      ['unknown', base, id(77)],
    ];
    for (const [label, state, viewerId] of cases) {
      const permissions = selectViewerPermissions(
        state,
        viewerId,
        conn(state, viewerId),
      );
      expect(
        selectRatingEntries(state, viewerId, conn(state, viewerId)).every(
          (entry) => !entry.canRate,
        ),
        `${label} rating targets`,
      ).toBe(true);
      expect(permissions.canRate, `${label} canRate`).toBe(false);
      expect(permissions.canSubmit, `${label} canSubmit`).toBe(false);
    }
  });

  it('denies writes to an older tab after the viewer rebound its connection', () => {
    const state = playbackState();
    const song = state.round!.playbackOrder[0];
    const staleConnection = state.players[id(1)].connectionId;
    const rebound = send(
      state,
      { type: 'JOIN', nickname: 'Host' },
      { actorId: id(1), connectionId: id(901), at: 8000 },
    );
    expect(rebound.players[id(1)].connectionId).toBe(id(901));
    expect(selectViewerPermissions(rebound, id(1), id(901))).toMatchObject({
      isHost: true,
      isParticipant: true,
      canRate: true,
      canAdvance: true,
      canPause: true,
      canKick: true,
    });
    expect(
      selectViewerPermissions(rebound, id(1), staleConnection),
    ).toMatchObject({
      isHost: false,
      isParticipant: true,
      canStartGame: false,
      canEditSettings: false,
      canKick: false,
      canAdvance: false,
      canPause: false,
      canResume: false,
      canEndGame: false,
      canRematch: false,
      canSubmit: false,
      canFinishSubmission: false,
      canRate: false,
    });
    expect(
      selectRatingEntries(rebound, id(1), staleConnection).every(
        (entry) => !entry.canRate,
      ),
    ).toBe(true);
    const staleCommand = action(
      rebound,
      { type: 'RATE', songId: song, value: 5 },
      { actorId: id(1), connectionId: staleConnection, at: 9000 },
    );
    expect(classifyCommand(rebound, staleCommand)).toBe('STALE');
    expect(reducer(rebound, staleCommand)).toBe(rebound);
  });

  it('denies writes for a missing or unknown viewer connection', () => {
    const state = playbackState();
    expect(selectViewerPermissions(state, id(1), null)).toMatchObject({
      isHost: false,
      isParticipant: true,
      canRate: false,
    });
    expect(selectViewerPermissions(state, id(1), id(777)).canRate).toBe(false);
    expect(
      selectRatingEntries(state, id(1), null).every((entry) => !entry.canRate),
    ).toBe(true);
    expect(selectViewerChoices(state, id(1)).media?.videoId).toBe(videoId(1));
  });
});

describe('selectStandings', () => {
  it('uses dense shared ranks and keeps departed players', () => {
    const final = scoredFinalState();
    expect(selectStandings(final, id(2)).map((entry) => entry.rank)).toEqual([
      1, 2, 3,
    ]);
    expect(selectStandings(final, id(2))[1]).toMatchObject({
      playerId: id(2),
      totalScore: 65,
      isSelf: true,
      status: 'player',
      delta: 65,
      previousRank: 1,
    });
    expect(
      selectStandings(final, id(1)).map((entry) => [
        entry.playerId,
        entry.delta,
      ]),
    ).toEqual([
      [id(1), 105],
      [id(2), 65],
      [id(3), 45],
    ]);
    let tied = lastSongState();
    const leaveAt =
      tied.phase.type === 'PLAYBACK' ? tied.phase.deadlineAt - 10 : 0;
    tied = command(tied, id(4), { type: 'LEAVE' }, leaveAt);
    tied = fireDeadline(tied);
    const standings = selectStandings(tied, id(1));
    // Nothing was rated, so every song ties at 0.0 and every owner gets +2.0.
    expect(standings.map((entry) => entry.rank)).toEqual([1, 1, 1, 1]);
    expect(standings.every((entry) => entry.totalScore === 20)).toBe(true);
    expect(standings.some((entry) => entry.status === 'left')).toBe(true);
    expect(standings[0].isSelf).toBe(true);
  });
});
