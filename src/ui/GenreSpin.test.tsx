import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenrePlate } from './pf/GenrePlate';

describe('GenrePlate', () => {
  it('renders the pop-in plate as a polite status by default', () => {
    const html = renderToStaticMarkup(
      <GenrePlate kicker="The reel has spoken" name="Schlager" />,
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
