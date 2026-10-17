import { create } from 'zustand';
import { readStoredJson, writeStoredJson } from './stored-pref';

/** The SFX toggle, kept across games and reloads (#111). */
export const SFX_STORAGE_KEY = 'banger-roulette.sfx';

export interface SfxState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/** Stored shape: `{ "enabled": false }`. */
interface StoredSfx {
  enabled: boolean;
}

function readStoredSfx(): boolean {
  const stored = readStoredJson(SFX_STORAGE_KEY);
  if (typeof stored !== 'object' || stored === null) {
    return true;
  }
  const { enabled } = stored as Partial<StoredSfx>;
  return typeof enabled === 'boolean' ? enabled : true;
}

/**
 * SPEC §6 effect toggle. The choice is remembered in localStorage
 * (`banger-roulette.sfx`), so a reload keeps the sounds off for someone who
 * turned them off. Nothing is written before the user changes the toggle.
 */
export const useSfxStore = create<SfxState>((set) => ({
  enabled: readStoredSfx(),
  setEnabled: (enabled) => {
    set({ enabled });
    writeStoredJson(SFX_STORAGE_KEY, { enabled });
  },
}));
