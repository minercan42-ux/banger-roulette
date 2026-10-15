import { describe, expect, test } from 'vitest';
import { sfxEventsFor, type SfxSnapshot } from './SfxDirector';

/** A quiet baseline; every case changes exactly the slice it is about. */
function snapshot(overrides: Partial<SfxSnapshot> = {}): SfxSnapshot {
  return {
    phase: 'LOBBY',
    spinning: false,
    spinTicks: 0,
    linkedEntries: 0,
    revealedEntries: 0,
    winnerRevealed: false,
    ...overrides,
  };
}

describe('sfxEventsFor', () => {
  test('spinTick per tick the wheel advanced', () => {
    const prev = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 3,
    });
    const next = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 6,
    });
    expect(sfxEventsFor(prev, next)).toEqual([
      'spinTick',
      'spinTick',
      'spinTick',
    ]);
  });

  test('a burst of skipped ticks is capped', () => {
    const prev = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 0,
    });
    const next = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 500,
    });
    expect(sfxEventsFor(prev, next)).toEqual(Array(8).fill('spinTick'));
  });

  test('spinStop when the wheel settles into the next phase', () => {
    const prev = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 24,
    });
    expect(sfxEventsFor(prev, snapshot({ phase: 'SUBMISSION' }))).toEqual([
      'spinStop',
      'phaseChange',
    ]);
  });

  test('linked when a linked entry reaches the screen', () => {
    const prev = snapshot({ phase: 'REVEAL', revealedEntries: 1 });
    const next = snapshot({
      phase: 'REVEAL',
      revealedEntries: 2,
      linkedEntries: 1,
    });
    // The entry itself appears too, so its revealEntry follows the chime.
    expect(sfxEventsFor(prev, next)).toEqual(['linked', 'revealEntry']);
  });

  test('revealEntry per entry that appears', () => {
    const next = snapshot({ phase: 'REVEAL', revealedEntries: 2 });
    expect(sfxEventsFor(snapshot({ phase: 'REVEAL' }), next)).toEqual([
      'revealEntry',
      'revealEntry',
    ]);
  });

  test('jackpot for the winner entry, after its revealEntry', () => {
    const next = snapshot({
      phase: 'REVEAL',
      revealedEntries: 1,
      winnerRevealed: true,
    });
    expect(sfxEventsFor(snapshot({ phase: 'REVEAL' }), next)).toEqual([
      'revealEntry',
      'jackpot',
    ]);
  });

  test('phaseChange on a boundary without another event', () => {
    expect(
      sfxEventsFor(snapshot({ phase: 'LOBBY' }), snapshot({ phase: 'VOTING' })),
    ).toEqual(['phaseChange']);
  });

  test('final fanfare when the game ends', () => {
    const prev = snapshot({
      phase: 'REVEAL',
      revealedEntries: 2,
      winnerRevealed: true,
    });
    expect(sfxEventsFor(prev, snapshot({ phase: 'FINAL' }))).toEqual([
      'phaseChange',
      'final',
    ]);
  });

  test('entering the spin fires no tick yet', () => {
    const prev = snapshot({ phase: 'LOBBY' });
    const next = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 2,
    });
    expect(sfxEventsFor(prev, next)).toEqual(['phaseChange']);
  });

  test('no events in PLAYBACK', () => {
    const spinning = snapshot({
      phase: 'GENRE_SPIN',
      spinning: true,
      spinTicks: 5,
    });
    expect(
      sfxEventsFor(spinning, snapshot({ phase: 'PLAYBACK', linkedEntries: 1 })),
    ).toEqual([]);
    expect(
      sfxEventsFor(
        snapshot({ phase: 'PLAYBACK', linkedEntries: 1 }),
        snapshot({ phase: 'PLAYBACK', linkedEntries: 1 }),
      ),
    ).toEqual([]);
  });

  test('a rewind or a late snapshot replays nothing', () => {
    const prev = snapshot({
      phase: 'REVEAL',
      revealedEntries: 3,
      winnerRevealed: true,
    });
    expect(
      sfxEventsFor(prev, snapshot({ phase: 'REVEAL', revealedEntries: 1 })),
    ).toEqual([]);
    expect(sfxEventsFor(prev, prev)).toEqual([]);
  });
});
