import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import de from '../content/locales/de.json';
import en from '../content/locales/en.json';
// eslint-disable-next-line boundaries/dependencies -- the test pins the moment lengths to the engine's reveal slot and preroll
import { PRE_ROLL_MS, REVEAL_PER_SONG_MS } from '../engine';
import type { SongView } from '../engine/selectors';
import {
  LINKED_PREROLL_MS,
  LINKED_REVEAL_MS,
  LinkedAnimation,
  listNames,
  prerollElapsedMs,
  signedPoints,
  type LinkedVariant,
} from './LinkedAnimation';

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

describe('Spiritually Linked moment timing', () => {
  it('fits the reveal slot of an entry and the playback preroll', () => {
    expect(LINKED_REVEAL_MS).toBeLessThanOrEqual(REVEAL_PER_SONG_MS);
    expect(LINKED_PREROLL_MS).toBeLessThanOrEqual(PRE_ROLL_MS);
  });
});

describe('Spiritually Linked wording helpers', () => {
  it('names every owner in the UI language', () => {
    expect(listNames(['Alice', 'Bob'], 'de')).toBe('Alice und Bob');
    expect(listNames(['Alice', 'Bob', 'Cara'], 'de')).toBe(
      'Alice, Bob und Cara',
    );
    expect(listNames(['Alice', 'Bob', 'Cara'], 'en')).toBe(
      'Alice, Bob, and Cara',
    );
    expect(listNames(['Alice'], 'en')).toBe('Alice');
  });

  it('signs a gain and keeps the minus of a penalty', () => {
    expect(signedPoints(80)).toBe('+8.0');
    expect(signedPoints(0)).toBe('+0.0');
    expect(signedPoints(-15)).toBe('-1.5');
  });
});

function song(overrides: Partial<SongView> = {}): SongView {
  return {
    videoId: 'linked00001',
    title: 'Shared Song',
    channel: 'Channel',
    thumbnail: '',
    durationSeconds: 0,
    startSeconds: 0,
    clipSeconds: 20,
    ownerCount: 3,
    ownedByViewer: false,
    owners: [
      { id: 'a', nickname: 'Alice' },
      { id: 'b', nickname: 'Bob' },
      { id: 'c', nickname: 'Cara' },
    ],
    ownersVisible: true,
    linked: true,
    ...overrides,
  };
}

function render(
  variant: LinkedVariant,
  songs: SongView[],
  extra: { pointsTenths?: number; held?: boolean } = {},
  language: 'de' | 'en' = 'de',
): string {
  const instance = i18next.createInstance();
  void instance.init({
    resources: { de: { translation: de }, en: { translation: en } },
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    initAsync: false,
    react: { useSuspense: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <LinkedAnimation songs={songs} variant={variant} {...extra} />
    </I18nextProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('Spiritually Linked reveal moment', () => {
  it('gives every owner of three a card, a name and their points', () => {
    const html = render('reveal', [song()], { pointsTenths: 80 });
    expect(count(html, 'data-testid="linked-owner"')).toBe(3);
    for (const name of ['Alice', 'Bob', 'Cara']) {
      expect(html).toContain(`>${name}</span>`);
    }
    expect(count(html, 'data-testid="linked-owner-points"')).toBe(3);
    expect(count(html, '>+8.0</span>')).toBe(3);
    expect(html).toContain('+8.0 für Alice, Bob und Cara');
    expect(html).toContain('data-motion="full"');
  });

  it('words the two-owner line in English too', () => {
    const html = render(
      'reveal',
      [
        song({
          ownerCount: 2,
          owners: [
            { id: 'a', nickname: 'Alice' },
            { id: 'b', nickname: 'Bob' },
          ],
        }),
      ],
      { pointsTenths: 45 },
      'en',
    );
    expect(count(html, 'data-testid="linked-owner"')).toBe(2);
    expect(html).toContain('+4.5 for Alice and Bob');
  });

  it('rests at its settled frame while a show holds the viewport', () => {
    const html = render('reveal', [song()], { pointsTenths: 80, held: true });
    expect(html).toContain('data-held="true"');
    expect(html).toContain('data-motion="calm"');
    expect(html).toContain('br-linked--calm');
    // No effect layers (flash, rings, sparks) are drawn for a settled moment.
    expect(html).not.toContain('br-linked__spark');
    expect(html).toContain('+8.0 für Alice, Bob und Cara');
  });
});

describe('Spiritually Linked preroll (AK-3)', () => {
  const anonymous = song({ owners: [], ownersVisible: false, ownerCount: 2 });

  it('shows one face-down card per owner and names no one', () => {
    const html = render('preroll', [anonymous]);
    expect(html).toContain('data-variant="preroll"');
    expect(count(html, 'br-linked__seat"')).toBe(2);
    expect(html).not.toContain('data-testid="linked-owner"');
    expect(html).not.toContain('linked-owner-points');
    expect(html).not.toContain('Alice');
    expect(html).toContain('data-testid="linked-anonymous"');
    expect(html).not.toContain('is-flipped');
  });

  it('keeps the marker when nothing is linked', () => {
    const html = render('preroll', [song({ linked: false })]);
    expect(html).toContain('data-testid="linked-animation-none"');
    expect(render('reveal', [song({ linked: false })])).toBe('');
  });
});
