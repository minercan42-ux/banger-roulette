import { describe, expect, it } from 'vitest';
import { FALLBACK_LANGUAGE, detectLanguage, isLanguage } from './language';

describe('detectLanguage', () => {
  it('takes the first supported tag in user priority order', () => {
    expect(detectLanguage(['fr-FR', 'en-US', 'de-DE'])).toBe('en');
  });

  it('maps region and separator variants to the base language', () => {
    expect(detectLanguage(['de-AT'])).toBe('de');
    expect(detectLanguage(['en_GB'])).toBe('en');
    expect(detectLanguage(['EN-us'])).toBe('en');
  });

  it('falls back to de when no candidate is supported', () => {
    expect(detectLanguage(['fr', 'es-MX'])).toBe('de');
    expect(detectLanguage([])).toBe(FALLBACK_LANGUAGE);
  });

  it('recognizes only the supported languages', () => {
    expect(isLanguage('de')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage('de-DE')).toBe(false);
  });
});
