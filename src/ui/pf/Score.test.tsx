import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GameSession } from '../../net/session';
import { Progress, progressPercent } from './Progress';
import {
  COMBO_DURATION_MS,
  comboDurationMs,
  comboFrame,
  comboKind,
  comboValues,
  runComboTimeline,
  ScoreCombo,
  type ComboScheduler,
  type ComboValues,
} from './ScoreCombo';
import { remainingUntil, TimerStat, URGENT_MS } from './Stat';

function sessionAt(now: number): GameSession {
  return { now: () => now } as unknown as GameSession;
}

function timer(now: number, pausedAt: number | null = null): string {
  return renderToStaticMarkup(
    <TimerStat
      session={sessionAt(now)}
      deadlineAt={60_000}
      pausedAt={pausedAt}
      label="Time"
      announce={(time) => `${time} left`}
      liveTestId="live"
      data-testid="timer"
    />,
  );
}

describe('comboValues', () => {
  it('splits a winner into average + jackpot = round score (tenths)', () => {
    const entry = {
      scoreTenths: 85,
      bonus: 20,
      roundPoints: 105,
      genreFailed: false,
    };
    expect(comboValues(entry)).toEqual({ votes: 85, adjust: 20, total: 105 });
    expect(comboKind(entry)).toBe('jackpot');
  });

  it('keeps votes + adjust = total for a genre fail (negative adjust)', () => {
    const entry = {
      scoreTenths: 30,
      bonus: 0,
      roundPoints: 10,
      genreFailed: true,
    };
    const { votes, adjust, total } = comboValues(entry);
    expect(adjust).toBe(-20);
    expect(votes + adjust).toBe(total);
    expect(comboKind(entry)).toBe('penalty');
  });

  it('labels a halved linked song as a share', () => {
    const entry = {
      scoreTenths: 80,
      bonus: 20,
      roundPoints: 50,
      genreFailed: false,
    };
    expect(comboKind(entry)).toBe('shared');
    expect(comboValues(entry).total).toBe(50);
  });

  it('counts up well inside the 2500 ms a reveal entry gets', () => {
    expect(COMBO_DURATION_MS).toBeLessThan(2500);
  });
});

describe('combo timeline (one shared clock)', () => {
  const winner: ComboValues = { votes: 100, adjust: 20, total: 120 };

  it('runs the stages back to back inside 1800 ms', () => {
    expect(comboDurationMs(winner)).toBe(1800);
    expect(comboDurationMs(winner)).toBe(COMBO_DURATION_MS);
    expect(comboFrame(winner, 0)).toEqual({ votes: 0, adjust: 0, total: 0 });
    expect(comboFrame(winner, 450)).toEqual({ votes: 50, adjust: 0, total: 0 });
    expect(comboFrame(winner, 900)).toEqual({
      votes: 100,
      adjust: 0,
      total: 0,
    });
    expect(comboFrame(winner, 1050)).toEqual({
      votes: 100,
      adjust: 10,
      total: 0,
    });
    expect(comboFrame(winner, 1500)).toEqual({
      votes: 100,
      adjust: 20,
      total: 60,
    });
    expect(comboFrame(winner, 1800)).toEqual(winner);
    expect(comboFrame(winner, 60_000)).toEqual(winner);
  });

  it('skips a box that stays at zero', () => {
    const plain: ComboValues = { votes: 27, adjust: 0, total: 27 };
    expect(comboDurationMs(plain)).toBe(1500);
    expect(comboFrame(plain, 900).total).toBe(0);
    expect(comboFrame(plain, 1500)).toEqual(plain);
  });

  it('counts a penalty down to its negative amount', () => {
    const failed: ComboValues = { votes: 30, adjust: -20, total: 10 };
    expect(comboFrame(failed, 1050).adjust).toBe(-10);
    expect(comboFrame(failed, 1800)).toEqual(failed);
  });

  /** A manual frame clock and timer queue on a shared fake time. */
  function harness(start: number) {
    let time = start;
    let handle = 0;
    const frames = new Map<number, () => void>();
    const timers = new Map<number, { at: number; run: () => void }>();
    const scheduler: ComboScheduler = {
      requestFrame: (run) => {
        frames.set(++handle, run);
        return handle;
      },
      cancelFrame: (id) => void frames.delete(id),
      setTimer: (run, ms) => {
        timers.set(++handle, { at: time + ms, run });
        return handle;
      },
      clearTimer: (id) => void timers.delete(id),
    };
    return {
      scheduler,
      now: () => time,
      /** Deliver one animation frame at `at`. */
      frame: (at: number) => {
        time = at;
        const due = [...frames.values()];
        frames.clear();
        due.forEach((run) => run());
      },
      /** Advance the clock; fires every timer that is due. */
      advance: (to: number) => {
        time = to;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= time) {
            timers.delete(id);
            timer.run();
          }
        }
      },
      pending: () => frames.size + timers.size,
    };
  }

  it('shows the settled total at its scheduled time with only a few frames', () => {
    const clock = harness(10_000);
    const seen: ComboValues[] = [];
    runComboTimeline(
      winner,
      () => clock.now() - 10_000,
      (f) => seen.push(f),
      clock.scheduler,
    );
    // A starved frame clock: one frame at 100 ms, then nothing until 1700 ms.
    clock.frame(10_100);
    clock.advance(11_700);
    expect(seen[seen.length - 1].total).toBeLessThan(winner.total);
    // No frame ever arrives again; the settle timer alone completes the count.
    clock.advance(11_800);
    expect(seen[seen.length - 1]).toEqual(winner);
    expect(clock.pending()).toBe(0);
  });

  it('seeks to the shared offset when the frame arrives late', () => {
    const clock = harness(0);
    const seen: ComboValues[] = [];
    runComboTimeline(
      winner,
      () => clock.now(),
      (f) => seen.push(f),
      clock.scheduler,
    );
    // One frame, 1500 ms in: the bonus and half the sum, not the chained start.
    clock.frame(1_500);
    expect(seen[seen.length - 1]).toEqual({
      votes: 100,
      adjust: 20,
      total: 60,
    });
    clock.frame(1_900);
    expect(seen[seen.length - 1]).toEqual(winner);
    expect(clock.pending()).toBe(0);
  });

  it('stops without a trace when cancelled', () => {
    const clock = harness(0);
    const stop = runComboTimeline(
      winner,
      () => clock.now(),
      () => undefined,
      clock.scheduler,
    );
    stop();
    expect(clock.pending()).toBe(0);
  });
});

describe('ScoreCombo', () => {
  const props = {
    votes: 73,
    adjust: 20,
    total: 93,
    votesLabel: 'Votes',
    adjustLabel: 'Jackpot',
    totalLabel: 'Round',
  };

  it('shows the engine values at once when it does not animate', () => {
    const html = renderToStaticMarkup(
      <ScoreCombo {...props} animate={false} />,
    );
    expect(html).toMatch(/score-combo-votes[^>]*>7\.3</);
    expect(html).toMatch(/score-combo-adjust[^>]*>2\.0</);
    expect(html).toMatch(/score-combo-total[^>]*>9\.3</);
    expect(html).toContain('data-total="93"');
  });

  it('starts at zero while it counts up and is decoration for readers', () => {
    const html = renderToStaticMarkup(<ScoreCombo {...props} />);
    expect(html).toMatch(/score-combo-total[^>]*>0\.0</);
    expect(html).toContain('aria-hidden="true"');
  });

  it('draws a penalty as a minus sign with the absolute amount', () => {
    const html = renderToStaticMarkup(
      <ScoreCombo
        {...props}
        votes={30}
        adjust={-20}
        total={10}
        animate={false}
      />,
    );
    expect(html).toContain('br-combo__op">-<');
    expect(html).toMatch(/score-combo-adjust[^>]*>2\.0</);
  });
});

describe('Progress', () => {
  it('clamps the fill and reports the position on the progressbar', () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(500, 200)).toBe(100);
    expect(progressPercent(-5, 200)).toBe(0);
    const html = renderToStaticMarkup(
      <Progress value={50} max={200} tone="blue" />,
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain('br-progress--blue');
    expect(html).toContain('width:25%');
  });
});

describe('TimerStat', () => {
  it('computes against the deadline, frozen while paused', () => {
    expect(remainingUntil(60_000, 18_000, null)).toBe(42_000);
    expect(remainingUntil(60_000, 99_000, 20_000)).toBe(40_000);
    expect(remainingUntil(60_000, 70_000, null)).toBe(0);
  });

  it('renders m:ss with the timer role and no urgency above 10 s', () => {
    const html = timer(18_000);
    expect(html).toContain('role="timer"');
    expect(html).toContain('>0:42<');
    expect(html).toContain('data-remaining-ms="42000"');
    expect(html).not.toContain('is-urgent');
    expect(html).toContain('0:40 left');
  });

  it('turns urgent at 10 s or less', () => {
    expect(URGENT_MS).toBe(10_000);
    expect(timer(50_000)).toContain('is-urgent');
    expect(timer(50_001)).toContain('is-urgent');
    expect(timer(49_999)).not.toContain('is-urgent');
  });

  it('stays on the pause instant', () => {
    const html = timer(99_000, 20_000);
    expect(html).toContain('>0:40<');
    expect(html).toContain('data-paused="true"');
  });
});
