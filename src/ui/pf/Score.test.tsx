import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GameSession } from '../../net/session';
import { Progress, progressPercent } from './Progress';
import {
  COMBO_DURATION_MS,
  comboKind,
  comboValues,
  ScoreCombo,
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
