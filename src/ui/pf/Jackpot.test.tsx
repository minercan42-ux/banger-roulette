import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line boundaries/dependencies -- the test pins the UI show length to the engine's reveal slot
import { REVEAL_PER_SONG_MS } from '../../engine';
import { Jackpot, JACKPOT_MS, jackpotChips } from './Jackpot';

describe('jackpot show (FR-60)', () => {
  it('completes within the engine reveal slot', () => {
    expect(JACKPOT_MS).toBeLessThanOrEqual(REVEAL_PER_SONG_MS);
    for (const seed of ['a', 'dQw4w9WgXcQ', 'x|y|z', '']) {
      for (const chip of jackpotChips(seed)) {
        expect(chip.delay + chip.fall).toBeLessThanOrEqual(1800);
      }
    }
  });

  it('derives identical chip rain from the same song ids on every client', () => {
    const first = jackpotChips('dQw4w9WgXcQ|aaaaaaaaaaa');
    expect(jackpotChips('dQw4w9WgXcQ|aaaaaaaaaaa')).toEqual(first);
    expect(jackpotChips('aaaaaaaaaaa|dQw4w9WgXcQ')).not.toEqual(first);
    expect(first).toHaveLength(26);
    for (const chip of first) {
      expect(chip.left).toBeGreaterThanOrEqual(0);
      expect(chip.left).toBeLessThanOrEqual(100);
      expect(Math.abs(chip.drift)).toBeLessThanOrEqual(40);
      expect(Math.abs(chip.spin)).toBeGreaterThanOrEqual(360);
    }
  });

  it('renders nothing before the winner is revealed and after the show', () => {
    const winners = [
      {
        videoId: 'dQw4w9WgXcQ',
        revealAt: 10_000,
        roundPoints: 11,
        names: ['A'],
      },
    ];
    const render = (now: number) =>
      renderToStaticMarkup(
        <Jackpot winners={winners} now={now} paused={false} />,
      );
    expect(render(9_999)).toBe('');
    expect(render(10_000 + JACKPOT_MS)).toBe('');
    expect(
      renderToStaticMarkup(
        <Jackpot winners={[]} now={10_000} paused={false} />,
      ),
    ).toBe('');
  });
});
