import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line boundaries/dependencies -- the test pins the UI show length to the engine's banger slot
import { BANGER_REVEAL_MS, REVEAL_PER_SONG_MS } from '../../engine';
import {
  BANGER_FINALE_MS,
  BANGER_SHOW_MS,
  BangerShow,
  bangerParams,
  shakeKeyframes,
  type BangerEntry,
} from './BangerShow';

const ENTRY: BangerEntry = {
  videoId: 'dQw4w9WgXcQ',
  revealAt: 10_000,
  slotMs: BANGER_REVEAL_MS,
  number: 2,
  title: 'Song',
  channel: 'Channel',
  thumbnail: '',
  scoreTenths: 100,
  roundPoints: 110,
  bonus: 10,
  names: ['Alice', 'Bob'],
};

describe('banger show (FR-60)', () => {
  it('is exactly as long as the engine banger slot', () => {
    expect(BANGER_SHOW_MS).toBe(BANGER_REVEAL_MS);
    expect(BANGER_SHOW_MS).toBeGreaterThan(REVEAL_PER_SONG_MS);
    expect(BANGER_FINALE_MS).toBeLessThan(BANGER_SHOW_MS);
  });

  it('derives identical parameters from the same song id on every client', () => {
    const first = bangerParams('dQw4w9WgXcQ');
    expect(bangerParams('dQw4w9WgXcQ')).toEqual(first);
    expect(bangerParams('aaaaaaaaaaa')).not.toEqual(first);
    expect(first.chips).toHaveLength(72);
    expect(first.confetti).toHaveLength(64);
  });

  it('keeps the rain, the confetti and the shake inside the show', () => {
    for (const seed of ['a', 'dQw4w9WgXcQ', 'x|y|z', '']) {
      const { chips, confetti, shake } = bangerParams(seed);
      for (const chip of chips) {
        expect(chip.delay + chip.fall).toBeLessThanOrEqual(
          BANGER_SHOW_MS - 300,
        );
        expect(chip.left).toBeGreaterThanOrEqual(0);
        expect(chip.left).toBeLessThanOrEqual(100);
      }
      for (const piece of confetti) {
        // The burst starts at the finale and needs its ~850 ms to settle.
        expect(BANGER_FINALE_MS + piece.delay + 850).toBeLessThanOrEqual(
          BANGER_SHOW_MS,
        );
      }
      expect(shake).toHaveLength(BANGER_SHOW_MS / 50 + 1);
      // Rest before the stamp, between the two jolts and at the very end.
      expect(shake[0]).toEqual({ x: 0, y: 0 });
      expect(shake[shake.length - 1]).toEqual({ x: 0, y: 0 });
      expect(
        shake.some((position) => position.x !== 0 || position.y !== 0),
      ).toBe(true);
    }
  });

  it('turns the shake into Web Animations keyframes from offset 0 to 1', () => {
    const frames = shakeKeyframes(bangerParams('dQw4w9WgXcQ').shake);
    expect(frames[0]?.offset).toBe(0);
    expect(frames[frames.length - 1]?.offset).toBe(1);
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index]!.offset!).toBeGreaterThan(
        frames[index - 1]!.offset!,
      );
    }
  });

  it('renders nothing before the entry is revealed, after the slot and without bangers', () => {
    const render = (now: number, entries: BangerEntry[] = [ENTRY]) =>
      renderToStaticMarkup(
        <BangerShow
          entries={entries}
          now={now}
          paused={false}
          showThumbnail={false}
        />,
      );
    expect(render(9_999)).toBe('');
    expect(render(10_000 + BANGER_REVEAL_MS)).toBe('');
    expect(render(10_000, [])).toBe('');
  });
});
