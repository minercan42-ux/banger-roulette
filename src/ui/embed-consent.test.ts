import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'banger-roulette.youtubeConsent';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

/** Fresh module instance, as a page load would see it. */
async function load(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
  const consent = await import('./embed-consent');
  const current = () =>
    renderToStaticMarkup(
      createElement(() => {
        const { state } = consent.useEmbedConsent();
        return createElement('i', null, state);
      }),
    );
  return { storage, consent, current };
}

describe('embedding consent store (#96)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts undecided for a new visitor and stores nothing', async () => {
    const { storage, consent, current } = await load();
    expect(consent.YOUTUBE_CONSENT_STORAGE_KEY).toBe(KEY);
    expect(current()).toBe('<i>undecided</i>');
    expect(storage.data.size).toBe(0);
  });

  it('persists a grant across loads and a revoke forgets it', async () => {
    const first = await load();
    first.consent.grantConsent();
    expect(first.current()).toBe('<i>granted</i>');
    expect(first.storage.data.get(KEY)).toBe('1');

    // A reload reads the stored grant back.
    const reloaded = await load(Object.fromEntries(first.storage.data));
    expect(reloaded.current()).toBe('<i>granted</i>');

    reloaded.consent.revokeConsent();
    expect(reloaded.current()).toBe('<i>declined</i>');
    expect(reloaded.storage.data.has(KEY)).toBe(false);
  });

  it('keeps "Ohne Videos" in memory only', async () => {
    const { storage, consent, current } = await load();
    consent.declineConsent();
    expect(current()).toBe('<i>declined</i>');
    expect(storage.data.size).toBe(0);
  });

  it('only the exact stored value "1" counts as consent', async () => {
    const { current } = await load({ [KEY]: 'yes' });
    expect(current()).toBe('<i>undecided</i>');
  });

  it('follows consent changes made in another tab', async () => {
    const storage = fakeStorage({ [KEY]: '1' });
    let onStorage: ((event: { key: string | null }) => void) | undefined;
    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener: (type: string, handler: typeof onStorage) => {
        if (type === 'storage') {
          onStorage = handler;
        }
      },
    });
    vi.resetModules();
    const consent = await import('./embed-consent');
    const current = () =>
      renderToStaticMarkup(
        createElement(() =>
          createElement('i', null, consent.useEmbedConsent().state),
        ),
      );
    expect(current()).toBe('<i>granted</i>');
    expect(onStorage).toBeTypeOf('function');

    // Unrelated keys are ignored.
    storage.data.delete(KEY);
    onStorage?.({ key: 'banger-roulette.clientId' });
    expect(current()).toBe('<i>granted</i>');

    // Revoked in another tab: this one stops too.
    onStorage?.({ key: KEY });
    expect(current()).toBe('<i>declined</i>');

    // Granted in another tab.
    storage.data.set(KEY, '1');
    onStorage?.({ key: KEY });
    expect(current()).toBe('<i>granted</i>');

    // Storage cleared (key === null).
    storage.data.clear();
    onStorage?.({ key: null });
    expect(current()).toBe('<i>declined</i>');
  });

  it('still works for this page load when storage is blocked', async () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('window', {
      localStorage: {
        getItem: blocked,
        setItem: blocked,
        removeItem: blocked,
      },
    });
    vi.resetModules();
    const consent = await import('./embed-consent');
    consent.grantConsent();
    const html = renderToStaticMarkup(
      createElement(() =>
        createElement('i', null, consent.useEmbedConsent().state),
      ),
    );
    expect(html).toBe('<i>granted</i>');
  });
});
