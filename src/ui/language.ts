export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const FALLBACK_LANGUAGE: Language = 'de';

export function isLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Picks the first supported base language from the given tags, else the fallback. */
export function detectLanguage(
  candidates: readonly string[],
  fallback: Language = FALLBACK_LANGUAGE,
): Language {
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split(/[-_]/)[0] ?? '';
    if (isLanguage(base)) {
      return base;
    }
  }
  return fallback;
}

/** Browser language preferences, ordered by user priority. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  const { languages, language } = navigator;
  if (languages.length > 0) {
    return languages;
  }
  return language ? [language] : [];
}
