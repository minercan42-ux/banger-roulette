/**
 * Minimal localStorage helpers for the UI preferences (#111): playback volume
 * and the SFX toggle. Both are best effort, like the embedding consent
 * (`src/ui/embed-consent.ts`): storage can be blocked (private mode, denied
 * site data) and a foreign or hand-edited value must never break a page load.
 * A read therefore answers `null` for anything it cannot parse, and a write
 * swallows its error - the preference then lasts for this page load only.
 */
export function readStoredJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Storage blocked, key missing or the value is not JSON: use the default.
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort, see readStoredJson.
  }
}
