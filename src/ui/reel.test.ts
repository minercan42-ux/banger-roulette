import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line boundaries/dependencies -- the test pins the UI timeline to the engine's phase length
import { SPIN_MS } from '../engine';
import {
  genreTargetAngle,
  reelAngle,
  reelEase,
  reelRows,
  reelTicks,
  reelTimeline,
  REEL_HOLD_MS,
  REEL_MIN_ROWS,
  REEL_ROW_DEG,
  REEL_SHAKE_MS,
  REEL_SPIN_MS,
  REEL_TICK_MS,
  REEL_VISIBLE_ROWS,
} from './reel';

const POOL_SIZES = [2, 3, 7, 12, 24, 50];

describe('genre reel angle (FR-10, AK-1)', () => {
  it('ends exactly on the selected genre for every pool size and index', () => {
    for (const count of POOL_SIZES) {
      for (let index = 0; index < count; index += 1) {
        const target = genreTargetAngle(index, count);
        expect(reelAngle(REEL_SPIN_MS, REEL_SPIN_MS, target)).toBe(target);
        expect(reelAngle(REEL_SPIN_MS + 1, REEL_SPIN_MS, target)).toBe(target);
        expect(reelAngle(SPIN_MS, REEL_SPIN_MS, target)).toBe(target);
        // The row in the window at the stop is the drawn genre, and the drum
        // travelled at least REEL_MIN_ROWS rows to get there.
        const rows = target / REEL_ROW_DEG;
        expect(Number.isInteger(rows)).toBe(true);
        expect(rows % count).toBe(index);
        expect(rows).toBeGreaterThanOrEqual(REEL_MIN_ROWS);
        const window = reelRows(target, count).find(
          (row) => Math.abs(row.offset) < 1e-9,
        );
        expect(window?.poolIndex).toBe(index);
      }
    }
  });

  it('starts at rest and approaches the target without overshoot', () => {
    const target = genreTargetAngle(4, 12);
    expect(reelAngle(0, REEL_SPIN_MS, target)).toBe(0);
    for (let ms = 0; ms <= REEL_SPIN_MS; ms += 1) {
      const angle = reelAngle(ms, REEL_SPIN_MS, target);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThanOrEqual(target);
    }
  });

  it('has a monotone non-increasing velocity over the whole spin', () => {
    for (const count of [2, 3, 12, 50]) {
      const target = genreTargetAngle(count - 1, count);
      let previousSpeed = Number.POSITIVE_INFINITY;
      let previousAngle = reelAngle(0, REEL_SPIN_MS, target);
      for (let ms = 1; ms <= REEL_SPIN_MS; ms += 1) {
        const angle = reelAngle(ms, REEL_SPIN_MS, target);
        const speed = angle - previousAngle;
        expect(speed).toBeGreaterThanOrEqual(-1e-9);
        expect(speed).toBeLessThanOrEqual(previousSpeed + 1e-6);
        previousSpeed = speed;
        previousAngle = angle;
      }
    }
  });

  it('is a pure function of elapsed time', () => {
    const target = genreTargetAngle(2, 9);
    expect(reelAngle(1234, REEL_SPIN_MS, target)).toBe(
      reelAngle(1234, REEL_SPIN_MS, target),
    );
    expect(reelEase(0.5)).toBe(reelEase(0.5));
    expect(reelEase(0)).toBe(0);
    expect(reelEase(1)).toBe(1);
  });

  it('keeps the stylesheet in step with the timeline', () => {
    const css = readFileSync('src/ui/styles.css', 'utf8');
    expect(css).toContain(`--dur-spin: ${REEL_SPIN_MS}ms;`);
    expect(css).toContain(`animation: br-shake ${REEL_SHAKE_MS}ms`);
    expect(css).toContain(`animation: br-reel-nudge ${REEL_TICK_MS}ms`);
    expect(css).toContain(
      `--reel-radius: calc(var(--reel-row) / ${(
        (REEL_ROW_DEG * Math.PI) /
        180
      ).toFixed(4)});`,
    );
  });
});

describe('genre reel timeline', () => {
  it('spins about 3.2 s and holds the result at least 2 s inside the engine phase', () => {
    const { spinMs, shakeMs } = reelTimeline(SPIN_MS);
    expect(spinMs).toBe(REEL_SPIN_MS);
    expect(shakeMs).toBe(REEL_SHAKE_MS);
    expect(SPIN_MS - spinMs).toBeGreaterThanOrEqual(REEL_HOLD_MS);
    expect(SPIN_MS).toBe(5500);
  });

  it('shortens the shake first, then the spin, never past the deadline', () => {
    expect(reelTimeline(3400)).toEqual({ spinMs: 3200, shakeMs: 200 });
    expect(reelTimeline(3200)).toEqual({ spinMs: 3200, shakeMs: 0 });
    expect(reelTimeline(2000)).toEqual({ spinMs: 2000, shakeMs: 0 });
    expect(reelTimeline(0)).toEqual({ spinMs: 0, shakeMs: 0 });
    for (const total of [0, 1, 420, 2000, 3199, 3200, 3201, 5500, 9000]) {
      const { spinMs, shakeMs } = reelTimeline(total);
      expect(spinMs + shakeMs).toBeLessThanOrEqual(total);
    }
  });

  it('keeps the exact end angle when the phase is shorter than the spin', () => {
    const target = genreTargetAngle(5, 12);
    const { spinMs } = reelTimeline(1500);
    expect(reelAngle(spinMs, spinMs, target)).toBe(target);
    expect(reelAngle(0, 0, target)).toBe(target);
  });
});

describe('reel ticks and rows', () => {
  it('counts one tick per row that passed the window', () => {
    expect(reelTicks(0)).toBe(0);
    expect(reelTicks(-5)).toBe(0);
    expect(reelTicks(REEL_ROW_DEG - 0.1)).toBe(0);
    expect(reelTicks(REEL_ROW_DEG)).toBe(1);
    expect(reelTicks(genreTargetAngle(3, 12))).toBe(
      Math.round(genreTargetAngle(3, 12) / REEL_ROW_DEG),
    );
  });

  it('renders a stable ring of rows around the window', () => {
    for (const count of POOL_SIZES) {
      for (const angle of [0, 13, 100.5, 700.25]) {
        const rows = reelRows(angle, count);
        expect(rows).toHaveLength(REEL_VISIBLE_ROWS);
        expect(new Set(rows.map((row) => row.slot)).size).toBe(
          REEL_VISIBLE_ROWS,
        );
        for (const row of rows) {
          expect(row.poolIndex).toBeGreaterThanOrEqual(0);
          expect(row.poolIndex).toBeLessThan(count);
          expect(Math.abs(row.offset)).toBeLessThanOrEqual(
            REEL_VISIBLE_ROWS / 2,
          );
          expect(row.degrees).toBeCloseTo(row.offset * REEL_ROW_DEG, 9);
        }
      }
    }
    expect(reelRows(100, 0)).toEqual([]);
  });

  it('shows neighbouring genres in pool order, wrapping around the drum', () => {
    const rows = reelRows(genreTargetAngle(0, 5), 5);
    const centre = rows.findIndex((row) => Math.abs(row.offset) < 1e-9);
    expect(rows[centre]?.poolIndex).toBe(0);
    expect(rows[centre - 1]?.poolIndex).toBe(4);
    expect(rows[centre + 1]?.poolIndex).toBe(1);
  });
});
