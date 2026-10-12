import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from '../content/locales/de.json';
import en from '../content/locales/en.json';
import {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  browserLanguages,
  detectLanguage,
} from './language';

void i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
  },
  lng: detectLanguage(browserLanguages()),
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  nonExplicitSupportedLngs: true,
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

export default i18n;
