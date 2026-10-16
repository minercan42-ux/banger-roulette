/** localStorage key that turns the developer diagnostics on (read only, the app never writes it). */
export const DEBUG_STORAGE_KEY = 'banger-roulette.debug';

/**
 * Whether the developer diagnostics (clock offset, RTT, planned/observed start,
 * drift, raw status) are shown. Off for players; on with `?debug=1` in the URL
 * or `localStorage['banger-roulette.debug'] === '1'`.
 */
export function isDebugMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    return true;
  }
  try {
    return window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    // Storage can be blocked (privacy mode); the flag is then simply off.
    return false;
  }
}
