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

/** The opening tag and content of one chip button. */
function chip(html: string, rating: number): string {
  const start = html.indexOf(
    `<button type="button" data-testid="rating-chip-${rating}"`,
  );
  return html.slice(start, html.indexOf('</button>', start));
}

describe('RatingBar (FR-40)', () => {
  it('renders the genre-fail chip 0 and one chip button per rating 1 to 10', () => {
    expect(RATINGS).toHaveLength(11);
    const html = bar(null);
    for (const rating of RATINGS) {
      expect(html).toContain(`data-testid="rating-chip-${rating}"`);
    }
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(11);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('marks only the chosen number as pressed and fills the chips up to it', () => {
    const html = bar(7);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/rating-chip-7"[^>]*aria-pressed="true"/);
    // Chips 1..7 are filled; the genre-fail chip never is.
    expect(html.match(/is-filled/g)).toHaveLength(7);
    expect(chip(html, 0)).not.toContain('is-filled');
    expect(chip(html, 8)).not.toContain('is-filled');
    expect(html).toContain('data-value="7"');
  });

  it('makes chip 0 the genre-fail chip with its own label and kind', () => {
    const zero = chip(bar(null), 0);
    expect(zero).toContain('data-kind="genre-fail"');
    expect(zero).toContain('aria-label="rating.genreFailAria"');
    expect(zero).toContain('title="rating.genreFailAria"');
    expect(zero).toContain('<svg aria-hidden="true"');
    expect(zero).not.toContain('>0<');
    expect(chip(bar(null), 1)).not.toContain('data-kind');
    expect(chip(bar(null), 1)).toContain('aria-label="rating.chipAria"');
    expect(chip(bar(null), 1)).not.toContain('<svg');
  });

  it('presses chip 0 only at value 0 and fills no number chip then', () => {
    const html = bar(0);
    expect(chip(html, 0)).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toContain('is-filled');
    expect(chip(html, 0)).not.toContain('is-filled');
    expect(html).toContain('data-value="0"');
    expect(bar(null)).toContain('data-value=""');
    expect(chip(bar(null), 0)).toContain('aria-pressed="false"');
    expect(chip(bar(3), 0)).toContain('aria-pressed="false"');
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
