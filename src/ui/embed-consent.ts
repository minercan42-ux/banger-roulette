import { useSyncExternalStore } from 'react';

/**
 * Per-tab embedding consent (FR-24/NFR-04). One decision gates *every* YouTube
 * load in this browser tab, including thumbnails, and it is deliberately
 * in-memory only: never persisted, so a reload or a fresh tab starts gated
 * again. Because the store lives in this module it is shared by SubmissionPanel
 * and PlaybackPhase, so the choice survives the SUBMISSION -> PLAYBACK phase
 * change without a reload. Each tab has its own module instance, so consent is
 * per tab by construction.
 */
let consented = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return consented;
}

/** Flips the shared flag and wakes every subscribed panel in this tab. */
function setConsent(value: boolean): void {
  if (consented === value) {
    return;
  }
  consented = value;
  for (const listener of listeners) {
    listener();
  }
}

export interface EmbedConsent {
  consented: boolean;
  setConsent: (value: boolean) => void;
}

/** Subscribes a component to the shared per-tab consent flag. */
export function useEmbedConsent(): EmbedConsent {
  const consented = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { consented, setConsent };
}
