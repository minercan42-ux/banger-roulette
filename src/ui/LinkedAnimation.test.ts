import { describe, expect, it } from 'vitest';
import { prerollElapsedMs } from './LinkedAnimation';

describe('Spiritually Linked preroll timeline (FR-26)', () => {
  // The preroll runs 10_000..13_000 on the shared server clock.
  const view = { startAt: 13_000, prerollMs: 3_000, pausedAt: null };

  it('joins a late mount at the shared offset, clamped to the preroll', () => {
    expect(prerollElapsedMs(view, 9_000)).toBe(0);
    expect(prerollElapsedMs(view, 10_000)).toBe(0);
    expect(prerollElapsedMs(view, 11_250)).toBe(1_250);
    expect(prerollElapsedMs(view, 20_000)).toBe(3_000);
  });

  it('freezes at the pause instant while the host paused', () => {
    const paused = { ...view, pausedAt: 11_500 };
    expect(prerollElapsedMs(paused, 11_500)).toBe(1_500);
    expect(prerollElapsedMs(paused, 15_000)).toBe(1_500);
  });
});
