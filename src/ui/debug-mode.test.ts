import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_STORAGE_KEY, isDebugMode } from './debug-mode';

function stubWindow(search: string, stored: string | null, throws = false) {
  vi.stubGlobal('window', {
    location: { search },
    localStorage: {
      getItem: (key: string) => {
        if (throws) {
          throw new Error('blocked');
        }
        return key === DEBUG_STORAGE_KEY ? stored : null;
      },
    },
  });
}

describe('isDebugMode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off for players', () => {
    stubWindow('', null);
    expect(isDebugMode()).toBe(false);
    stubWindow('?debug=0', '0');
    expect(isDebugMode()).toBe(false);
  });

  it('turns on with ?debug=1', () => {
    stubWindow('?x=1&debug=1', null);
    expect(isDebugMode()).toBe(true);
  });

  it('turns on with the banger-roulette.debug localStorage flag', () => {
    stubWindow('', '1');
    expect(isDebugMode()).toBe(true);
  });

  it('stays off when storage is blocked', () => {
    stubWindow('', null, true);
    expect(isDebugMode()).toBe(false);
  });
});
