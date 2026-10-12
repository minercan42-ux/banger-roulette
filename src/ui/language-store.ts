import { create } from 'zustand';
import i18n from './i18n';
import { FALLBACK_LANGUAGE, isLanguage, type Language } from './language';

type LanguageState = {
  language: Language;
  setLanguage: (language: Language) => void;
};

const resolved = i18n.resolvedLanguage;
const initialLanguage: Language =
  typeof resolved === 'string' && isLanguage(resolved)
    ? resolved
    : FALLBACK_LANGUAGE;

/** Local UI language; the single entry point for switching without a reload. */
export const useLanguageStore = create<LanguageState>((set) => ({
  language: initialLanguage,
  setLanguage: (language) => {
    if (i18n.resolvedLanguage !== language) {
      void i18n.changeLanguage(language);
    }
    set({ language });
  },
}));
