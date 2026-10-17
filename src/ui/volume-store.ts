import { create } from 'zustand';
import { readStoredJson, writeStoredJson } from './stored-pref';

export const DEFAULT_VOLUME = 20;

/** The user's playback volume and mute, kept across games and reloads (#111). */
export const VOLUME_STORAGE_KEY = 'banger-roulette.volume';

export interface VolumeState {
  /** 0..100, applied to every YouTube player this tab runs. */
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
}

/** Stored shape: `{ "level": 55, "muted": false }`. */
interface StoredVolume {
  level: number;
  muted: boolean;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The stored preference, or the defaults for a fresh visitor and for every
 * value that is missing or of the wrong type. A stored level outside 0..100 is
 * clamped instead of rejected, a stored `muted` only counts as `true`.
 */
function readStoredVolume(): { volume: number; muted: boolean } {
  const stored = readStoredJson(VOLUME_STORAGE_KEY);
  if (typeof stored !== 'object' || stored === null) {
    return { volume: DEFAULT_VOLUME, muted: false };
  }
  const { level, muted } = stored as Partial<StoredVolume>;
  return {
    volume: typeof level === 'number' ? clampVolume(level) : DEFAULT_VOLUME,
    muted: muted === true,
  };
}

/**
 * The tab's one playback volume (issue #107). The top-bar control writes it;
 * the room playback controller and the submission preview read it and push
 * every change into their player. The preference is remembered in localStorage
 * (`banger-roulette.volume`), so a reload starts at the last level and mute
 * state instead of the default. Nothing is written before the user changes
 * something, and there is no cross-tab sync.
 */
export const useVolumeStore = create<VolumeState>((set, get) => {
  const initial = readStoredVolume();
  return {
    volume: initial.volume,
    muted: initial.muted,
    setVolume: (volume) => {
      const next = clampVolume(volume);
      set({ volume: next });
      writeStoredJson(VOLUME_STORAGE_KEY, { level: next, muted: get().muted });
    },
    setMuted: (muted) => {
      set({ muted });
      writeStoredJson(VOLUME_STORAGE_KEY, { level: get().volume, muted });
    },
  };
});
