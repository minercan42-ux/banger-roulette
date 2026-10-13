import { describe, expect, it } from 'vitest';
import type { GameState } from '../shared/game';
import { classifyCommand, reducer } from './reducer';
import {
  areOwnersVisible,
  selectCurrentSong,
  selectEligibleSongs,
  selectFlaggableSongs,
  selectGenrePool,
  selectLobbyReadiness,
  selectPhaseTimer,
  selectResults,
  selectReveal,
  selectRoster,
  selectRound,
  selectRoom,
  selectSettings,
  selectSongs,
  selectStandings,
  selectViewerChoices,
  selectViewerPermissions,
} from './selectors';
import {
  action,
  command,
  fireDeadline,
  genre,
  id,
  makeSettings,
  media,
  newGame,
  playbackState,
  presence,
  revealState,
  scoredFinalState,
  send,
  startedGame,
  submissionState,
  validationError,
  videoId,
  votingState,
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

/** Round with two ballots, revealed at the voting deadline. */
function scoredReveal() {
  let state = votingState();
  state = command(
    state,
    id(1),
    { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
    200000,
  );
  state = command(
    state,
    id(2),
    { type: 'SET_RANKING', ranking: [videoId(1), videoId(3), videoId(4)] },
    200001,
  );
  return fireDeadline(state, 236203);
}

describe('selectRoom', () => {
  it('describes the room without protocol metadata', () => {
    const state = votingState();
    expect(selectRoom(state)).toEqual({
      roomCode: 'ABCDEF',
      gameNumber: 1,
      hostId: id(1),
      phase: 'VOTING',
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
      votingSeconds: 60,
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
    expect(selectPhaseTimer(state, 1000)).toEqual({
      phase: 'GENRE_SPIN',
      deadlineAt: 4000,
      totalMs: 3000,
      remainingMs: 3000,
      paused: false,
    });
    expect(selectPhaseTimer(state, 9000).remainingMs).toBe(0);
    const paused = command(state, id(1), { type: 'PAUSE' }, 2000);
    expect(selectPhaseTimer(paused, 9500)).toEqual({
      phase: 'GENRE_SPIN',
      deadlineAt: 4000,
      totalMs: 3000,
      remainingMs: 2000,
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
    expect(selectPhaseTimer(votingState(), 176203).totalMs).toBe(60000);
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
    state = fireDeadline(state, 94000);
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
    const voting = votingState();
    const reveal = revealState();
    const final = scoredFinalState();
    const keys = collectKeys(
      [
        selectRoom(voting),
        selectPhaseTimer(voting, 200000),
        selectLobbyReadiness(voting),
        selectRoster(voting, id(1)),
        selectRound(voting, id(1)),
        selectSongs(voting, id(1)),
        selectCurrentSong(voting, id(1)),
        selectEligibleSongs(voting, id(1), conn(voting, id(1))),
        selectFlaggableSongs(voting, id(1), conn(voting, id(1))),
        selectViewerChoices(voting, id(1)),
        selectViewerPermissions(voting, id(1), conn(voting, id(1))),
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
      'ballots',
      'genreFailFlags',
    ]) {
      expect([...keys]).not.toContain(forbidden);
    }
    expect(selectRound(voting, id(1))).toMatchObject({
      playbackIndex: null,
      currentVideoId: null,
    });
  });
});

describe('selectViewerChoices', () => {
  it('isolates the viewer choices from everyone else', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3)] },
      200000,
    );
    state = command(
      state,
      id(1),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      200001,
    );
    expect(selectViewerChoices(state, id(1))).toMatchObject({
      isParticipant: true,
      submitted: true,
      submissionDone: true,
      votingDone: false,
      ranking: [videoId(2), videoId(3)],
      flaggedVideoIds: [videoId(2)],
    });
    expect(selectViewerChoices(state, id(1)).media?.videoId).toBe(videoId(1));
    expect(selectViewerChoices(state, id(2))).toMatchObject({
      ranking: [],
      flaggedVideoIds: [],
    });
    expect(selectViewerChoices(state, id(2)).media?.videoId).toBe(videoId(2));
    expect(selectViewerChoices(state, id(9))).toEqual({
      isParticipant: false,
      submitted: false,
      submissionDone: false,
      votingDone: false,
      media: null,
      ranking: [],
      flaggedVideoIds: [],
    });
  });
});

describe('selectEligibleSongs and selectFlaggableSongs', () => {
  it('excludes own and linked songs for the participant context', () => {
    const voting = votingState();
    const eligible = selectEligibleSongs(voting, id(1), conn(voting, id(1)));
    expect(eligible.map((song) => song.videoId)).toHaveLength(3);
    expect(eligible.some((song) => song.ownedByViewer)).toBe(false);
    expect(eligible.every((song) => song.ownerCount === 1)).toBe(true);
    expect(selectEligibleSongs(voting, id(9), conn(voting, id(9)))).toEqual([]);
    const done = command(voting, id(1), { type: 'FINISH_VOTING' }, 200000);
    expect(selectEligibleSongs(done, id(1), conn(done, id(1)))).toEqual([]);
    const playback = playbackState();
    const flaggable = selectFlaggableSongs(
      playback,
      id(1),
      conn(playback, id(1)),
    );
    expect(flaggable).toHaveLength(3);
    expect(flaggable.some((song) => song.ownedByViewer)).toBe(false);
    const withSpectator = send(
      playback,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 8000 },
    );
    expect(
      selectFlaggableSongs(withSpectator, id(9), conn(withSpectator, id(9))),
    ).toEqual([]);
    expect(
      selectFlaggableSongs(voting, id(1), conn(voting, id(1))),
    ).toHaveLength(3);
    expect(selectEligibleSongs(playback, id(1), conn(playback, id(1)))).toEqual(
      [],
    );
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
      canRank: false,
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
      canSetGenreFail: false,
    });
    const voting = votingState();
    expect(
      selectViewerPermissions(voting, id(1), conn(voting, id(1))),
    ).toMatchObject({
      canSubmit: false,
      canRank: true,
      canFinishVoting: true,
      canSetGenreFail: true,
      canAdvance: true,
    });
    const paused = command(voting, id(1), { type: 'PAUSE' }, 200000);
    expect(
      selectViewerPermissions(paused, id(1), conn(paused, id(1))),
    ).toMatchObject({
      canAdvance: false,
      canPause: false,
      canResume: true,
      canRank: false,
      canSetGenreFail: false,
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
      voting,
      id(1),
      { type: 'KICK', playerId: id(3) },
      200010,
    );
    expect(
      selectViewerPermissions(kicked, id(3), conn(kicked, id(3))),
    ).toMatchObject({
      isParticipant: true,
      isHost: false,
      canRank: false,
      canFinishVoting: false,
      canSetGenreFail: false,
    });
    const unknown = selectViewerPermissions(voting, id(77), null);
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
  it('orders ascending Borda with deterministic ties and banger links', () => {
    const reveal = scoredReveal();
    const view = selectReveal(reveal);
    expect(view?.reason).toBe('normal');
    expect(view?.entries.map((entry) => entry.videoId)).toEqual([
      videoId(4),
      videoId(1),
      videoId(2),
      videoId(3),
    ]);
    expect(view?.entries[0]).toMatchObject({
      borda: 2,
      roundPoints: 2,
      bonus: 0,
      winner: false,
      genreFailed: false,
      ownerCount: 1,
      linked: false,
    });
    expect(view?.entries[3]).toMatchObject({
      borda: 4,
      bonus: 2,
      roundPoints: 6,
      winner: true,
    });
    expect(view?.entries[3].owners).toEqual([
      { id: id(3), nickname: 'Player3' },
    ]);
    expect(view?.entries[3].watchUrl).toBe(
      `https://www.youtube.com/watch?v=${videoId(3)}&t=10s`,
    );
    const later = fireDeadline(reveal, 260000);
    expect(selectReveal(later)).toBeNull();
    expect(selectResults(later)).toHaveLength(1);
    expect(selectResults(later)[0].entries[3]).toMatchObject({
      winner: true,
      roundPoints: 6,
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
    state = fireDeadline(state, 94000);
    state = fireDeadline(state, 137000);
    state = fireDeadline(state, 180000);
    const reveal = fireDeadline(state, 240000);
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
    expect(results[0].entries.map((entry) => entry.borda)).toEqual([2, 3, 4]);
    expect(results[0].entries[2]).toMatchObject({
      winner: true,
      roundPoints: 6,
    });
    expect(results[0].entries[2].owners).toEqual([
      { id: id(1), nickname: 'Host' },
    ]);
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
    expect(selectEligibleSongs(lobby, id(1), conn(lobby, id(1)))).toEqual([]);
    expect(selectFlaggableSongs(lobby, id(1), conn(lobby, id(1)))).toEqual([]);
    expect(selectReveal(lobby)).toBeNull();
    expect(selectResults(lobby)).toEqual([]);
    expect(selectStandings(lobby, id(1)).map((entry) => entry.rank)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(selectViewerChoices(lobby, id(1))).toEqual({
      isParticipant: false,
      submitted: false,
      submissionDone: false,
      votingDone: false,
      media: null,
      ranking: [],
      flaggedVideoIds: [],
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

describe('selectable targets and finished voters', () => {
  it('locks ranking and flags for a voter that finished', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      200000,
    );
    state = command(state, id(1), { type: 'FINISH_VOTING' }, 200001);
    expect(
      selectViewerPermissions(state, id(1), conn(state, id(1))),
    ).toMatchObject({
      canRank: false,
      canFinishVoting: false,
      canSetGenreFail: false,
    });
    expect(selectEligibleSongs(state, id(1), conn(state, id(1)))).toEqual([]);
    expect(selectFlaggableSongs(state, id(1), conn(state, id(1)))).toEqual([]);
    expect(
      selectViewerPermissions(state, id(2), conn(state, id(2))).canSetGenreFail,
    ).toBe(true);
    expect(selectFlaggableSongs(state, id(2), conn(state, id(2)))).toHaveLength(
      3,
    );
    const flagAfterFinish = action(
      state,
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      { actorId: id(1), connectionId: id(101), at: 200002 },
    );
    expect(classifyCommand(state, flagAfterFinish)).toBe('FORBIDDEN');
    expect(reducer(state, flagAfterFinish)).toBe(state);
    expect(selectViewerChoices(state, id(1))).toMatchObject({
      votingDone: true,
      ranking: [videoId(2), videoId(3), videoId(4)],
    });
  });

  it('keeps selectable lists aligned with the permission hints', () => {
    const base = command(
      votingState(),
      id(2),
      { type: 'SET_RANKING', ranking: [videoId(1), videoId(3), videoId(4)] },
      199000,
    );
    const late = send(
      base,
      { type: 'JOIN', nickname: 'Late' },
      { actorId: id(9), connectionId: id(109), at: 200000 },
    );
    const cases: [string, GameState, string][] = [
      ['paused', command(base, id(1), { type: 'PAUSE' }, 200000), id(2)],
      [
        'disconnected',
        presence(base, 200000, [id(101), id(103), id(104)]),
        id(2),
      ],
      ['left', command(base, id(2), { type: 'LEAVE' }, 200000), id(2)],
      [
        'kicked',
        command(base, id(1), { type: 'KICK', playerId: id(2) }, 200000),
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
        selectEligibleSongs(state, viewerId, conn(state, viewerId)),
        `${label} ranking targets`,
      ).toEqual([]);
      expect(
        selectFlaggableSongs(state, viewerId, conn(state, viewerId)),
        `${label} flag targets`,
      ).toEqual([]);
      expect(permissions.canRank, `${label} canRank`).toBe(false);
      expect(permissions.canSetGenreFail, `${label} canSetGenreFail`).toBe(
        false,
      );
      expect(permissions.canSubmit, `${label} canSubmit`).toBe(false);
      expect(
        selectViewerChoices(state, viewerId).ranking,
        `${label} stored choices`,
      ).toEqual(state.round?.ballots[viewerId]?.ranking ?? []);
    }
  });

  it('offers a playback flag target once and reopens it during voting', () => {
    let state = playbackState();
    const targets = selectFlaggableSongs(state, id(1), conn(state, id(1)));
    expect(targets).toHaveLength(3);
    expect(targets.map((song) => song.videoId)).not.toContain(videoId(1));
    state = command(
      state,
      id(1),
      { type: 'SET_GENRE_FAIL', videoId: videoId(2), flagged: true },
      8000,
    );
    const afterFlag = selectFlaggableSongs(state, id(1), conn(state, id(1)));
    expect(afterFlag).toHaveLength(2);
    expect(afterFlag.map((song) => song.videoId)).not.toContain(videoId(2));
    expect(
      selectViewerPermissions(state, id(1), conn(state, id(1))).canSetGenreFail,
    ).toBe(true);
    for (let step = 0; step < 6; step += 1) {
      if (state.phase.type !== 'PLAYBACK') {
        break;
      }
      state = fireDeadline(state);
    }
    expect(state.phase.type).toBe('VOTING');
    expect(
      selectFlaggableSongs(state, id(1), conn(state, id(1))).map(
        (song) => song.videoId,
      ),
    ).toContain(videoId(2));
  });

  it('drops the flag permission when no permitted foreign song remains', () => {
    let state = playbackState();
    [videoId(2), videoId(3), videoId(4)].forEach((target, index) => {
      state = command(
        state,
        id(1),
        { type: 'SET_GENRE_FAIL', videoId: target, flagged: true },
        8000 + index,
      );
    });
    expect(selectViewerChoices(state, id(1)).flaggedVideoIds).toHaveLength(3);
    expect(selectFlaggableSongs(state, id(1), conn(state, id(1)))).toEqual([]);
    expect(
      selectViewerPermissions(state, id(1), conn(state, id(1))).canSetGenreFail,
    ).toBe(false);
    expect(validationError(state)).toBeNull();
  });

  it('denies writes to an older tab after the viewer rebound its connection', () => {
    let state = votingState();
    state = command(
      state,
      id(1),
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(3), videoId(4)] },
      200000,
    );
    const staleConnection = state.players[id(1)].connectionId;
    const rebound = send(
      state,
      { type: 'JOIN', nickname: 'Host' },
      { actorId: id(1), connectionId: id(901), at: 200001 },
    );
    expect(rebound.players[id(1)].connectionId).toBe(id(901));
    expect(selectViewerPermissions(rebound, id(1), id(901))).toMatchObject({
      isHost: true,
      isParticipant: true,
      canRank: true,
      canFinishVoting: true,
      canSetGenreFail: true,
      canAdvance: true,
      canPause: true,
      canKick: true,
    });
    expect(selectEligibleSongs(rebound, id(1), id(901))).toHaveLength(3);
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
      canRank: false,
      canFinishVoting: false,
      canSetGenreFail: false,
    });
    expect(selectEligibleSongs(rebound, id(1), staleConnection)).toEqual([]);
    expect(selectFlaggableSongs(rebound, id(1), staleConnection)).toEqual([]);
    expect(selectViewerChoices(rebound, id(1)).ranking).toEqual([
      videoId(2),
      videoId(3),
      videoId(4),
    ]);
    const staleCommand = action(
      rebound,
      { type: 'SET_RANKING', ranking: [videoId(2), videoId(4), videoId(3)] },
      { actorId: id(1), connectionId: staleConnection, at: 200002 },
    );
    expect(classifyCommand(rebound, staleCommand)).toBe('STALE');
    expect(reducer(rebound, staleCommand)).toBe(rebound);
  });

  it('denies writes for a missing or unknown viewer connection', () => {
    const state = votingState();
    expect(selectViewerPermissions(state, id(1), null)).toMatchObject({
      isHost: false,
      isParticipant: true,
      canRank: false,
      canSetGenreFail: false,
    });
    expect(selectViewerPermissions(state, id(1), id(777)).canRank).toBe(false);
    expect(selectEligibleSongs(state, id(1), null)).toEqual([]);
    expect(selectFlaggableSongs(state, id(1), id(777))).toEqual([]);
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
      totalScore: 3,
      isSelf: true,
      status: 'player',
    });
    let tied = votingState();
    tied = command(tied, id(4), { type: 'LEAVE' }, 200000);
    tied = fireDeadline(tied, 236203);
    const standings = selectStandings(tied, id(1));
    expect(standings.map((entry) => entry.rank)).toEqual([1, 1, 1, 1]);
    expect(standings.every((entry) => entry.totalScore === 2)).toBe(true);
    expect(standings.some((entry) => entry.status === 'left')).toBe(true);
    expect(standings[0].isSelf).toBe(true);
  });
});
