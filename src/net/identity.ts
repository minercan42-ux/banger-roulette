import { Id } from '../shared/primitives';

/** Minimal storage surface so tests and SSR can inject their own. */
export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CLIENT_ID_STORAGE_KEY = 'banger-roulette.clientId';

/** Raised when the browser refuses to read or write the identity store. */
export class IdentityStorageError extends Error {
  constructor(cause?: unknown) {
    super('clientId storage is unavailable');
    this.name = 'IdentityStorageError';
    this.cause = cause;
  }
}

/**
 * Returns the retained `clientId` or creates and stores a new one. A storage
 * failure throws instead of silently minting a throwaway identity, so a reload
 * cannot lose the player's score.
 */
export function loadOrCreateClientId(
  storage: IdentityStorage,
  createId: () => string,
): string {
  let existing: string | null;
  try {
    existing = storage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch (cause) {
    throw new IdentityStorageError(cause);
  }
  if (existing !== null && Id.safeParse(existing).success) {
    return existing;
  }
  const created = createId();
  try {
    storage.setItem(CLIENT_ID_STORAGE_KEY, created);
  } catch (cause) {
    throw new IdentityStorageError(cause);
  }
  return created;
}
