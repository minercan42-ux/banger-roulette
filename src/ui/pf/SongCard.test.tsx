import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Hand } from './Hand';
import { fanRotation, SongCard } from './SongCard';

const SONG = {
  title: 'Harder Better Faster Stronger',
  channel: 'Daft Punk',
  thumbnail: 'https://i.ytimg.com/vi/gAjR4_CbPpQ/hqdefault.jpg',
};

describe('SongCard', () => {
  it('a face-down card carries nothing of the song', () => {
    const html = renderToStaticMarkup(
      <SongCard number={2} label="Song, face down" />,
    );
    expect(html).toContain('br-card__back');
    expect(html).not.toContain('is-flipped');
    expect(html).not.toContain('br-card__face');
    expect(html).not.toContain('br-card__owner');
    expect(html).toContain('aria-label="Song, face down"');
  });

  it('a face-up card prints title and channel and flips', () => {
    const html = renderToStaticMarkup(
      <SongCard number={3} song={SONG} label="Song 3: Harder" />,
    );
    expect(html).toContain('is-flipped');
    expect(html).toContain(SONG.title);
    expect(html).toContain(SONG.channel);
  });

  it('keeps the front face data but stays turned over until flipped is set', () => {
    const html = renderToStaticMarkup(
      <SongCard number={1} song={SONG} flipped={false} label="Song 1" />,
    );
    expect(html).not.toContain('is-flipped');
    expect(html).toContain('br-card__face');
  });

  it('only names an owner through the explicit owner stamp (AK-3)', () => {
    const before = renderToStaticMarkup(
      <SongCard number={1} song={SONG} label="Song 1: Harder" />,
    );
    expect(before).not.toContain('br-card__owner');
    const after = renderToStaticMarkup(
      <SongCard number={1} song={SONG} owner="Alice" />,
    );
    expect(after).toContain('br-card__owner');
    expect(after).toContain('Alice');
    // The extra fields of a song view never leak into the markup.
    const leaky = { ...SONG, owners: [{ id: 'p1', nickname: 'Bruno' }] };
    const view = renderToStaticMarkup(<SongCard number={1} song={leaky} />);
    expect(view).not.toContain('Bruno');
    expect(view).not.toContain('p1');
  });

  it('loads the thumbnail only on request (embed consent)', () => {
    const without = renderToStaticMarkup(<SongCard number={1} song={SONG} />);
    expect(without).not.toContain('<img');
    const withThumb = renderToStaticMarkup(
      <SongCard number={1} song={SONG} showThumbnail thumbnailTestId="thumb" />,
    );
    expect(withThumb).toContain(`src="${SONG.thumbnail}"`);
    expect(withThumb).toContain('data-testid="thumb"');
    expect(withThumb).toContain('no-referrer');
  });

  it('a card without a label is decoration for assistive technology', () => {
    const html = renderToStaticMarkup(<SongCard number={1} song={SONG} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="group"');
  });

  it('renders a button with a toggle state when it has a click handler', () => {
    const html = renderToStaticMarkup(
      <SongCard
        number={1}
        song={SONG}
        label="Add"
        pressed={false}
        onClick={() => undefined}
      />,
    );
    expect(html.startsWith('<button')).toBe(true);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('br-card--static');
  });

  it('idle wobble sits on static cards only, tilt on every fanned card', () => {
    const still = renderToStaticMarkup(
      <SongCard number={1} index={1} label="x" />,
    );
    expect(still).toContain('br-wobble');
    expect(still).toContain('--r:3deg');
    const clickable = renderToStaticMarkup(
      <SongCard number={1} index={1} label="x" onClick={() => undefined} />,
    );
    expect(clickable).not.toContain('br-wobble');
    expect(clickable).toContain('--r:3deg');
  });

  it('marks winner, selection, rank and the genre-fail slot', () => {
    const html = renderToStaticMarkup(
      <SongCard
        number={1}
        song={SONG}
        winner
        selected
        dim
        rank={2}
        flag="Genre fail"
      />,
    );
    expect(html).toContain('is-winner');
    expect(html).toContain('is-selected');
    expect(html).toContain('is-dim');
    expect(html).toContain('br-card__rank');
    expect(html).toContain('br-card__flag');
  });
});

describe('fanRotation', () => {
  it('stays within -6deg to 9deg and cycles', () => {
    for (let index = 0; index < 20; index += 1) {
      const degrees = fanRotation(index);
      expect(degrees).toBeGreaterThanOrEqual(-6);
      expect(degrees).toBeLessThanOrEqual(9);
    }
    expect(fanRotation(0)).toBe(fanRotation(8));
  });
});

describe('Hand', () => {
  it('is a named group of cards', () => {
    const html = renderToStaticMarkup(
      <Hand label="Songs of this round">
        <SongCard number={1} label="a" />
      </Hand>,
    );
    expect(html).toContain('class="br-hand"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Songs of this round"');
  });
});
