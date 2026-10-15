import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line boundaries/dependencies -- the test pins the UI timeline to the engine's phase length
import { SPIN_MS } from '../engine';
import {
  genreTargetAngle,
  POINTER_TICK_MS,
  WHEEL_EASE,
  WHEEL_SHAKE_MS,
  WHEEL_SPIN_MS,
  wheelAngle,
  wheelEase,
  wheelLabelLayout,
  wheelTicks,
  wheelTimeline,
} from './GenreSpin';
import { GenrePlate } from './pf/GenrePlate';

const POOL_SIZES = [2, 3, 7, 12, 24, 50];

describe('genre wheel angle (FR-10)', () => {
  it('ends exactly on genreTargetAngle() for every pool size and index', () => {
    for (const count of POOL_SIZES) {
      for (let index = 0; index < count; index += 1) {
        const target = genreTargetAngle(index, count);
        expect(wheelAngle(WHEEL_SPIN_MS, WHEEL_SPIN_MS, target)).toBe(target);
        expect(wheelAngle(WHEEL_SPIN_MS + 1, WHEEL_SPIN_MS, target)).toBe(
          target,
        );
        expect(wheelAngle(SPIN_MS, WHEEL_SPIN_MS, target)).toBe(target);
        // The segment centre of the drawn genre rests under the top pointer.
        const segment = 360 / count;
        const centre = index * segment + segment / 2;
        expect((((target + centre) % 360) + 360) % 360).toBeCloseTo(0, 6);
      }
    }
  });

  it('starts at rest and approaches the target without overshoot', () => {
    const target = genreTargetAngle(4, 12);
    expect(wheelAngle(0, WHEEL_SPIN_MS, target)).toBe(0);
    for (let ms = 0; ms <= WHEEL_SPIN_MS; ms += 1) {
      const angle = wheelAngle(ms, WHEEL_SPIN_MS, target);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThanOrEqual(target);
    }
  });

  it('has a monotone non-increasing angular velocity over the whole spin', () => {
    for (const count of [3, 12, 50]) {
      const target = genreTargetAngle(count - 1, count);
      let previousSpeed = Number.POSITIVE_INFINITY;
      let previousAngle = wheelAngle(0, WHEEL_SPIN_MS, target);
      for (let ms = 1; ms <= WHEEL_SPIN_MS; ms += 1) {
        const angle = wheelAngle(ms, WHEEL_SPIN_MS, target);
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
    expect(wheelAngle(1234, WHEEL_SPIN_MS, target)).toBe(
      wheelAngle(1234, WHEEL_SPIN_MS, target),
    );
    expect(wheelEase(0.5)).toBe(wheelEase(0.5));
  });

  it('uses the --ease-wheel curve and --dur-spin of the stylesheet', () => {
    const css = readFileSync('src/ui/styles.css', 'utf8');
    expect(css).toContain(
      `--ease-wheel: cubic-bezier(${WHEEL_EASE.join(', ')});`,
    );
    expect(css).toContain(`--dur-spin: ${WHEEL_SPIN_MS}ms;`);
    expect(css).toContain(`animation: br-shake ${WHEEL_SHAKE_MS}ms`);
    expect(css).toContain(`animation: br-pointer-tick ${POINTER_TICK_MS}ms`);
  });
});

describe('genre wheel timeline', () => {
  it('fits spin plus shake into the engine spin phase', () => {
    const { spinMs, shakeMs } = wheelTimeline(SPIN_MS);
    expect(spinMs).toBe(WHEEL_SPIN_MS);
    expect(shakeMs).toBe(WHEEL_SHAKE_MS);
    expect(spinMs + shakeMs).toBeLessThanOrEqual(SPIN_MS);
  });

  it('shortens the shake first, then the spin, never past the deadline', () => {
    expect(wheelTimeline(2800)).toEqual({ spinMs: 2580, shakeMs: 220 });
    expect(wheelTimeline(2580)).toEqual({ spinMs: 2580, shakeMs: 0 });
    expect(wheelTimeline(2000)).toEqual({ spinMs: 2000, shakeMs: 0 });
    expect(wheelTimeline(0)).toEqual({ spinMs: 0, shakeMs: 0 });
    for (const total of [0, 1, 420, 2000, 2579, 2580, 2581, 2999, 3000, 9000]) {
      const { spinMs, shakeMs } = wheelTimeline(total);
      expect(spinMs + shakeMs).toBeLessThanOrEqual(total);
    }
  });

  it('keeps the exact end angle when the phase is shorter than the spin', () => {
    const target = genreTargetAngle(5, 12);
    const { spinMs } = wheelTimeline(1500);
    expect(wheelAngle(spinMs, spinMs, target)).toBe(target);
    expect(wheelAngle(0, 0, target)).toBe(target);
  });
});

describe('pointer ticks and labels', () => {
  it('counts one tick per passed segment', () => {
    expect(wheelTicks(0, 12)).toBe(0);
    expect(wheelTicks(29.9, 12)).toBe(0);
    expect(wheelTicks(30, 12)).toBe(1);
    expect(wheelTicks(1800, 12)).toBe(60);
    expect(wheelTicks(100, 0)).toBe(0);
  });

  it('never lets labels outgrow their segment', () => {
    for (const count of POOL_SIZES) {
      const { fontSize, maxChars } = wheelLabelLayout(count);
      expect(fontSize).toBeGreaterThanOrEqual(8);
      expect(fontSize).toBeLessThanOrEqual(21);
      expect(maxChars).toBeGreaterThanOrEqual(3);
    }
    expect(wheelLabelLayout(12)).toEqual({ fontSize: 21, maxChars: 9 });
  });
});

describe('GenrePlate', () => {
  it('renders the pop-in plate as a polite status by default', () => {
    const html = renderToStaticMarkup(
      <GenrePlate kicker="The wheel has spoken" name="Schlager" />,
    );
    expect(html).toContain('class="br-genre is-in"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('br-genre__kicker');
    expect(html).toContain('Schlager');
  });

  it('hides from assistive tech when another element announces the result', () => {
    const html = renderToStaticMarkup(
      <GenrePlate kicker="Genre" name="Rap" live={false} />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="status"');
  });

  it('flags long names for the smaller plate type', () => {
    expect(
      renderToStaticMarkup(
        <GenrePlate kicker="k" name="Neue Deutsche Welle" />,
      ),
    ).toContain('data-long="true"');
    expect(
      renderToStaticMarkup(<GenrePlate kicker="k" name="Rap" />),
    ).toContain('data-long="false"');
  });
});
