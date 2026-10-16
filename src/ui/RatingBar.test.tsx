import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatTenths } from './format';
import { RatingBar, RATINGS } from './RatingBar';

function bar(value: number | null, disabled = false): string {
  return renderToStaticMarkup(
    <RatingBar
      value={value}
      disabled={disabled}
      label="Rate"
      testId="rating-bar"
      chipTestId="rating-chip"
      onRate={() => undefined}
    />,
  );
}

describe('RatingBar (FR-40)', () => {
  it('renders one chip button per rating 0 to 10', () => {
    expect(RATINGS).toHaveLength(11);
    const html = bar(null);
    for (const rating of RATINGS) {
      expect(html).toContain(`data-testid="rating-chip-${rating}"`);
    }
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(11);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('marks only the chosen value as pressed and fills the chips below it', () => {
    const html = bar(7);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/rating-chip-7"[^>]*aria-pressed="true"/);
    expect(html.match(/is-filled/g)).toHaveLength(8);
    expect(html).toContain('data-value="7"');
  });

  it('keeps a rating of 0 pressed and distinct from unrated', () => {
    expect(bar(0)).toMatch(/rating-chip-0"[^>]*aria-pressed="true"/);
    expect(bar(null)).toContain('data-value=""');
  });

  it('disables every chip while rating is closed', () => {
    expect(bar(3, true).match(/disabled=""/g)).toHaveLength(11);
  });
});

describe('formatTenths (FR-50, FR-53)', () => {
  it('shows integer tenths with exactly one decimal', () => {
    expect(formatTenths(73)).toBe('7.3');
    expect(formatTenths(100)).toBe('10.0');
    expect(formatTenths(0)).toBe('0.0');
    expect(formatTenths(5)).toBe('0.5');
    expect(formatTenths(105)).toBe('10.5');
  });

  it('keeps the sign of a penalty', () => {
    expect(formatTenths(-30)).toBe('-3.0');
    expect(formatTenths(-5)).toBe('-0.5');
  });
});
