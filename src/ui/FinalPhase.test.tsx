import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import de from '../content/locales/de.json';
import en from '../content/locales/en.json';
import type { RevealEntryView, RoundResultView } from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { FinalPhase } from './FinalPhase';

const mocked = vi.hoisted(() => ({ results: [] as unknown[] }));

vi.mock('../engine/selectors', () => ({
  selectFinal: () => ({ reason: 'completed' }),
  selectResults: () => mocked.results,
  selectStandings: () => [],
  selectViewerPermissions: () => ({ canRematch: false }),
}));

type Language = 'de' | 'en';

function render(language: Language = 'en'): string {
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
      <FinalPhase
        session={{} as GameSession}
        state={{} as GameState}
        viewerId="viewer"
        viewerConnectionId={null}
      />
    </I18nextProvider>,
  );
}

function entry(overrides: Partial<RevealEntryView>): RevealEntryView {
  return {
    videoId: 'video00001',
    title: 'Song',
    channel: 'Channel',
    thumbnail: '',
    startSeconds: 0,
    clipSeconds: 20,
    watchUrl: 'https://www.youtube.com/watch?v=video00001',
    owners: [],
    ownerCount: 1,
    linked: false,
    scoreTenths: 50,
    ratingCount: 0,
    banger: false,
    basis: 'ratings',
    bonus: 0,
    roundPoints: 50,
    genreFailed: false,
    flaggerIds: [],
    winner: false,
    ...overrides,
  };
}

function round(
  entries: RevealEntryView[],
  reason: RoundResultView['reason'] = 'normal',
): RoundResultView {
  return {
    roundNumber: 1,
    genre: { id: 'rock', de: 'Rock', en: 'Rock' },
    reason,
    entries,
  };
}

const unrated = (id: string) =>
  entry({ videoId: id, basis: 'noRaters', ownerCount: 3, linked: true });
const failed = (id: string) =>
  entry({ videoId: id, genreFailed: true, scoreTenths: 80 });

beforeEach(() => {
  mocked.results = [];
});

describe('FinalPhase round without a winner', () => {
  it('names the fixed bonus when every song was scored without raters', () => {
    mocked.results = [round([unrated('video00001')])];
    const html = render();
    expect(html).toContain(
      'Everyone submitted the same song, so everyone gets the fixed bonus.',
    );
    expect(html).not.toContain('genre fail');
    expect(html).not.toContain('final-round-winner');
  });

  it('keeps the genre-fail wording when every song failed the genre', () => {
    mocked.results = [round([failed('video00001'), failed('video00002')])];
    const html = render();
    expect(html).toContain('Every song in this round got a genre fail.');
    expect(html).not.toContain('fixed bonus');
  });

  it('keeps the no-song wording for a round nobody submitted to', () => {
    mocked.results = [round([], 'noSongs')];
    const html = render();
    expect(html).toContain('No song in this round.');
    expect(html).not.toContain('genre fail');
    expect(html).not.toContain('fixed bonus');
  });

  it('falls back to a neutral line for any other no-winner mix', () => {
    mocked.results = [round([failed('video00001'), unrated('video00002')])];
    const html = render();
    expect(html).toContain('This round has no round winner.');
    expect(html).not.toContain('genre fail');
    expect(html).not.toContain('fixed bonus');
  });

  it('lists the winning banger instead of a no-winner line', () => {
    mocked.results = [
      round([entry({ winner: true, title: 'Winning Song' }), unrated('v2')]),
    ];
    const html = render();
    expect(html).toContain('final-round-winner');
    expect(html).toContain('Winning Song');
    expect(html).not.toContain('no round winner');
  });

  it('renders the German wording', () => {
    mocked.results = [round([unrated('video00001')])];
    expect(render('de')).toContain(
      'Alle haben denselben Song eingereicht, alle bekommen den Festbonus.',
    );
    mocked.results = [round([failed('video00001')])];
    expect(render('de')).toContain(
      'Alle Songs dieser Runde bekamen einen Genre-Fail.',
    );
    mocked.results = [round([failed('video00001'), unrated('video00002')])];
    expect(render('de')).toContain('Diese Runde hat keinen Rundensieger.');
  });
});
