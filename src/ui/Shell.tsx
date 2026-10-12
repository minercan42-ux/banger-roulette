import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import genres from '../content/genres.json';
import './i18n';
import './styles.css';
import { SUPPORTED_LANGUAGES, type Language } from './language';
import { useLanguageStore } from './language-store';

export function Shell() {
  const { t } = useTranslation();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('app.title');
  }, [language, t]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl rounded-2xl border border-gold-400/25 bg-felt-900/70 p-5 shadow-2xl shadow-black/40 backdrop-blur-sm sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gold-400/20 pb-4">
          <span className="font-display text-xs tracking-[0.35em] text-gold-300 uppercase">
            {t('app.title')}
          </span>
          <div className="flex items-center gap-2">
            <label
              htmlFor="language-switch"
              className="text-xs text-gold-300/80"
            >
              {t('language.label')}
            </label>
            <select
              id="language-switch"
              data-testid="language-switch"
              aria-label={t('language.label')}
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value as Language);
              }}
              className="rounded-md border border-gold-400/40 bg-felt-950 px-2 py-1 text-sm text-cream-100 focus-visible:ring-2 focus-visible:ring-gold-300 focus-visible:outline-none"
            >
              {SUPPORTED_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`language.options.${code}`)}
                </option>
              ))}
            </select>
          </div>
        </header>
        <main className="pt-6">
          <p className="inline-block rounded-full border border-gold-400/30 px-3 py-1 text-xs tracking-wide text-gold-300 uppercase">
            {t('shell.status')}
          </p>
          <h1 className="shell-title font-display mt-4 text-3xl leading-tight font-semibold sm:text-4xl">
            {t('shell.heading')}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-cream-100/80 sm:text-base">
            {t('shell.description')}
          </p>
          <p className="mt-4 text-sm text-gold-300">
            {t('shell.genresReady', { count: genres.length })}
          </p>
          <p className="mt-6 rounded-lg border border-gold-400/20 bg-felt-800/60 p-3 text-xs leading-relaxed text-cream-100/70">
            {t('shell.notice')}
          </p>
        </main>
        <footer className="mt-6 border-t border-gold-400/20 pt-4 text-xs text-cream-100/60">
          {t('shell.footer')}
        </footer>
      </div>
    </div>
  );
}
