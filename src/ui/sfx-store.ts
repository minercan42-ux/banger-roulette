import { create } from 'zustand';

export interface SfxState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/**
 * SPEC §6 effect toggle. In memory only on purpose: a persisted flag would add
 * a second localStorage key, and `e2e/lobby.spec.ts` asserts that `clientId` is
 * the only stored key (FR-04).
 */
export const useSfxStore = create<SfxState>((set) => ({
  enabled: true,
  setEnabled: (enabled) => {
    set({ enabled });
  },
}));
