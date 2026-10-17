import { create } from 'zustand';

export const DEFAULT_VOLUME = 70;

export interface VolumeState {
  /** 0..100, applied to every YouTube player this tab runs. */
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The tab's one playback volume (issue #107). The top-bar control writes it;
 * the room playback controller and the submission preview read it and push
 * every change into their player. In memory only on purpose, like the SFX
 * toggle: a persisted value would add a second localStorage key, and
 * `e2e/lobby.spec.ts` asserts that `clientId` is the only stored key (FR-04).
 */
export const useVolumeStore = create<VolumeState>((set) => ({
  volume: DEFAULT_VOLUME,
  muted: false,
  setVolume: (volume) => {
    set({ volume: clampVolume(volume) });
  },
  setMuted: (muted) => {
    set({ muted });
  },
}));
