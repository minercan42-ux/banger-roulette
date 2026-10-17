import { afterEach, describe, expect, it, vi } from 'vitest';

const VOLUME_KEY = 'banger-roulette.volume';
const SFX_KEY = 'banger-roulette.sfx';

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

/**
 * Fresh module instances, as a page load would see them. The stores hydrate at
 * module load, so only a dynamic import after `vi.resetModules()` exercises the
 * page-load path; a static import would freeze the first storage stub.
 */
async function loadVolume(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
  const volumeStore = await import('./volume-store');
  return { storage, volumeStore };
}

async function loadSfx(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  vi.stubGlobal('window', { localStorage: storage });
  vi.resetModules();
  const sfxStore = await import('./sfx-store');
  return { storage, sfxStore };
}

function blockStorage() {
  const blocked = () => {
    throw new Error('blocked');
  };
  vi.stubGlobal('window', {
    localStorage: { getItem: blocked, setItem: blocked, removeItem: blocked },
  });
}

describe('volume store persistence (#111)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at 20 % unmuted for a fresh visitor and stores nothing', async () => {
    const { storage, volumeStore } = await loadVolume();

    expect(volumeStore.DEFAULT_VOLUME).toBe(20);
    expect(volumeStore.VOLUME_STORAGE_KEY).toBe(VOLUME_KEY);
    expect(volumeStore.useVolumeStore.getState().volume).toBe(20);
    expect(volumeStore.useVolumeStore.getState().muted).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it('hydrates a stored level and mute state', async () => {
    const { volumeStore } = await loadVolume({
      [VOLUME_KEY]: JSON.stringify({ level: 55, muted: true }),
    });

    expect(volumeStore.useVolumeStore.getState().volume).toBe(55);
    expect(volumeStore.useVolumeStore.getState().muted).toBe(true);
  });

  it('clamps a stored level instead of trusting it', async () => {
    const high = await loadVolume({
      [VOLUME_KEY]: JSON.stringify({ level: 250, muted: false }),
    });
    expect(high.volumeStore.useVolumeStore.getState().volume).toBe(100);

    const low = await loadVolume({
      [VOLUME_KEY]: JSON.stringify({ level: -5, muted: false }),
    });
    expect(low.volumeStore.useVolumeStore.getState().volume).toBe(0);
  });

  it('falls back to the defaults for corrupt JSON and wrong types', async () => {
    for (const stored of [
      'not json',
      JSON.stringify({ level: '55', muted: 'yes' }),
      JSON.stringify({ level: 55.4, muted: 1 }),
      JSON.stringify([55, true]),
      JSON.stringify('55'),
      JSON.stringify(null),
      '{}',
    ]) {
      const { volumeStore } = await loadVolume({ [VOLUME_KEY]: stored });
      const state = volumeStore.useVolumeStore.getState();
      expect({ stored, volume: state.volume, muted: state.muted }).toEqual({
        stored,
        // 55.4 rounds to 55, every other case falls back to the default.
        volume: stored === JSON.stringify({ level: 55.4, muted: 1 }) ? 55 : 20,
        muted: false,
      });
    }
  });

  it('uses the defaults when reading storage is blocked', async () => {
    blockStorage();
    vi.resetModules();
    const volumeStore = await import('./volume-store');

    expect(volumeStore.useVolumeStore.getState().volume).toBe(20);
    expect(volumeStore.useVolumeStore.getState().muted).toBe(false);
  });

  it('writes { level, muted } on setVolume and setMuted', async () => {
    const { storage, volumeStore } = await loadVolume();

    volumeStore.useVolumeStore.getState().setVolume(55);
    expect(storage.data.get(VOLUME_KEY)).toBe(
      JSON.stringify({ level: 55, muted: false }),
    );

    volumeStore.useVolumeStore.getState().setMuted(true);
    expect(storage.data.get(VOLUME_KEY)).toBe(
      JSON.stringify({ level: 55, muted: true }),
    );

    volumeStore.useVolumeStore.getState().setVolume(120);
    expect(volumeStore.useVolumeStore.getState().volume).toBe(100);
    expect(storage.data.get(VOLUME_KEY)).toBe(
      JSON.stringify({ level: 100, muted: true }),
    );
  });

  it('still updates the state when writing storage is blocked', async () => {
    blockStorage();
    vi.resetModules();
    const volumeStore = await import('./volume-store');

    expect(() => {
      volumeStore.useVolumeStore.getState().setVolume(55);
      volumeStore.useVolumeStore.getState().setMuted(true);
    }).not.toThrow();
    expect(volumeStore.useVolumeStore.getState().volume).toBe(55);
    expect(volumeStore.useVolumeStore.getState().muted).toBe(true);
  });
});

describe('sfx store persistence (#111)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts enabled for a fresh visitor and stores nothing', async () => {
    const { storage, sfxStore } = await loadSfx();

    expect(sfxStore.SFX_STORAGE_KEY).toBe(SFX_KEY);
    expect(sfxStore.useSfxStore.getState().enabled).toBe(true);
    expect(storage.data.size).toBe(0);
  });

  it('hydrates a stored toggle and falls back for bad values', async () => {
    const off = await loadSfx({
      [SFX_KEY]: JSON.stringify({ enabled: false }),
    });
    expect(off.sfxStore.useSfxStore.getState().enabled).toBe(false);

    for (const stored of [
      'not json',
      JSON.stringify({ enabled: 'no' }),
      '{}',
    ]) {
      const { sfxStore } = await loadSfx({ [SFX_KEY]: stored });
      expect({
        stored,
        enabled: sfxStore.useSfxStore.getState().enabled,
      }).toEqual({ stored, enabled: true });
    }
  });

  it('writes { enabled } on setEnabled', async () => {
    const { storage, sfxStore } = await loadSfx();

    sfxStore.useSfxStore.getState().setEnabled(false);
    expect(storage.data.get(SFX_KEY)).toBe(JSON.stringify({ enabled: false }));

    sfxStore.useSfxStore.getState().setEnabled(true);
    expect(storage.data.get(SFX_KEY)).toBe(JSON.stringify({ enabled: true }));
  });

  it('uses the default when storage is blocked and does not throw', async () => {
    blockStorage();
    vi.resetModules();
    const sfxStore = await import('./sfx-store');

    expect(sfxStore.useSfxStore.getState().enabled).toBe(true);
    expect(() => {
      sfxStore.useSfxStore.getState().setEnabled(false);
    }).not.toThrow();
    expect(sfxStore.useSfxStore.getState().enabled).toBe(false);
  });
});
