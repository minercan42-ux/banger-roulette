import { useSyncExternalStore } from 'react';

/**
 * Embedding consent (FR-24/NFR-04). One decision gates *every* YouTube load in
 * this browser, including thumbnails, and it is stored: `"1"` under
 * `banger-roulette.youtubeConsent` means "videos from youtube-nocookie.com may
 * load" across games and reloads. Only the grant is persisted. Declining
 * ("Ohne Videos") and revoking are in-memory for this page load, so the next
 * visit asks again instead of remembering a refusal.
 *
 * The store lives in this module, so the start gate, the drawer and every
 * phase that shows YouTube content read the same value. Other tabs follow: a
 * `storage` event for the key moves a granted tab to `declined` when the grant
 * is removed and a declined/undecided tab to `granted` when it is set.
 */
export const YOUTUBE_CONSENT_STORAGE_KEY = 'banger-roulette.youtubeConsent';

export type ConsentState = 'granted' | 'declined' | 'undecided';

function readStored(): boolean {
  try {
    return window.localStorage.getItem(YOUTUBE_CONSENT_STORAGE_KEY) === '1';
  } catch {
    // Storage blocked: the choice then lasts for this page load only.
    return false;
  }
}

function writeStored(granted: boolean): void {
  try {
    if (granted) {
      window.localStorage.setItem(YOUTUBE_CONSENT_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(YOUTUBE_CONSENT_STORAGE_KEY);
    }
  } catch {
    // Best effort, see readStored.
  }
}

let state: ConsentState = readStored() ? 'granted' : 'undecided';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ConsentState {
  return state;
}

function transition(next: ConsentState): void {
  if (state === next) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Another tab changed the stored decision (or cleared storage, `key === null`).
 * A withdrawn grant must stop this tab too, so it goes to `declined` and the
 * usual teardown paths run without a reload; a grant elsewhere carries over.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== YOUTUBE_CONSENT_STORAGE_KEY) {
    return;
  }
  if (readStored()) {
    transition('granted');
  } else if (state === 'granted') {
    transition('declined');
  }
}

if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener('storage', onStorage);
}

/** "Los geht's": videos may load now and on every later visit. */
export function grantConsent(): void {
  writeStored(true);
  transition('granted');
}

/** "Ohne Videos": no YouTube request this page load, nothing stored. */
export function declineConsent(): void {
  transition('declined');
}

/** Drawer action: forget the stored grant and stop loading YouTube content. */
export function revokeConsent(): void {
  writeStored(false);
  transition('declined');
}

export interface EmbedConsent {
  state: ConsentState;
  consented: boolean;
}

/** Subscribes a component to the shared embedding consent. */
export function useEmbedConsent(): EmbedConsent {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { state: current, consented: current === 'granted' };
}
