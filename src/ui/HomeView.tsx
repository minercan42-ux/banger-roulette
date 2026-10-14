import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import genres from '../content/genres.json';
import type { SessionError } from '../net/errors';
import { Chip } from './Chip';
import { normalizeRoomCode, ROOM_CODE_PATTERN } from './format';

interface HomeViewProps {
  prefillCode: string | null;
  joining: boolean;
  identityMissing: boolean;
  onCreate: (nickname: string) => Promise<SessionError | null>;
  onJoin: (code: string, nickname: string) => Promise<SessionError | null>;
}

function nicknameError(nickname: string): boolean {
  const trimmed = nickname.trim();
  return trimmed.length < 1 || trimmed.length > 20;
}

export function HomeView({
  prefillCode,
  joining,
  identityMissing,
  onCreate,
  onJoin,
}: HomeViewProps) {
  const { t } = useTranslation();
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(
    prefillCode ? normalizeRoomCode(prefillCode) : '',
  );
  const [joinNickname, setJoinNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function submitCreate() {
    if (nicknameError(nickname)) {
      setErrorKey('errors.INVALID');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const error = await onCreate(nickname.trim());
    if (error) {
      setErrorKey(`errors.${error}`);
    }
    setBusy(false);
  }

  async function submitJoin() {
    if (!ROOM_CODE_PATTERN.test(code)) {
      setErrorKey('errors.INVALID_ROOM_CODE');
      return;
    }
    if (nicknameError(joinNickname)) {
      setErrorKey('errors.INVALID');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const error = await onJoin(code, joinNickname.trim());
    if (error) {
      setErrorKey(`errors.${error}`);
    }
    setBusy(false);
  }

  return (
    <div data-testid="home-view" className="space-y-6">
      <div className="flex items-center justify-between gap-4 py-2 sm:py-4">
        <div className="min-w-0">
          <h1 className="shell-title font-display text-3xl leading-tight font-semibold sm:text-5xl">
            {t('home.heading')}
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-cream-100/80">
            {t('home.intro')}
          </p>
        </div>
        <div
          aria-hidden="true"
          className="relative hidden shrink-0 pr-2 pl-4 sm:block"
        >
          <Chip tone="gold" size="lg" />
          <span className="casino-glow-neon absolute -right-1 -bottom-2 -rotate-12">
            <Chip tone="neon" size="md" />
          </span>
        </div>
      </div>

      {joining && (
        <p
          data-testid="route-joining"
          className="rounded-lg border border-gold-400/20 bg-felt-800/60 px-3 py-2 text-sm text-gold-200"
        >
          {t('home.rejoining')}
        </p>
      )}

      {!joining && (
        <div
          data-testid={prefillCode ? 'route-join-view' : 'home-forms'}
          className="grid gap-5 sm:grid-cols-2"
        >
          {identityMissing && (
            <p
              data-testid="identity-missing"
              role="status"
              className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 sm:col-span-2"
            >
              {t('home.identityMissing')}
            </p>
          )}

          {errorKey && (
            <p
              data-testid="home-error"
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 sm:col-span-2"
            >
              {t(errorKey)}
            </p>
          )}

          <form
            data-testid="create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
            className="casino-panel flex flex-col gap-3 rounded-xl border border-gold-400/30 p-5"
          >
            <h2 className="flex items-center gap-2 font-display text-xl text-gold-300">
              <Chip tone="gold" size="sm" />
              {t('home.createHeading')}
            </h2>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cream-100/80">
                {t('home.nicknameLabel')}
              </span>
              <input
                type="text"
                data-testid="create-nickname"
                value={nickname}
                maxLength={20}
                autoComplete="off"
                onChange={(event) => setNickname(event.target.value)}
                className="min-h-11 min-w-0 rounded-md border border-gold-300/50 bg-felt-950 px-3 py-2 text-cream-100"
              />
              <span className="text-xs leading-relaxed text-cream-100/70">
                {t('home.nicknameHint')}
              </span>
            </label>
            <button
              type="submit"
              data-testid="create-room"
              disabled={busy}
              className="casino-glow-gold mt-auto min-h-11 rounded-md border border-gold-300 bg-gold-300 px-4 py-2 text-sm font-semibold text-felt-950 transition-colors hover:bg-gold-200 disabled:opacity-50"
            >
              {t('home.createButton')}
            </button>
          </form>

          <form
            data-testid="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitJoin();
            }}
            className="casino-panel flex flex-col gap-3 rounded-xl border border-gold-400/30 p-5"
          >
            <h2 className="flex items-center gap-2 font-display text-xl text-gold-300">
              <Chip tone="black" size="sm" />
              {t('home.joinHeading')}
            </h2>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cream-100/80">
                {t('home.joinCodeLabel')}
              </span>
              <input
                type="text"
                data-testid="join-code"
                value={code}
                maxLength={6}
                autoComplete="off"
                inputMode="text"
                onChange={(event) =>
                  setCode(normalizeRoomCode(event.target.value))
                }
                className="min-h-11 min-w-0 rounded-md border border-gold-300/50 bg-felt-950 px-3 py-2 font-mono tracking-[0.3em] text-cream-100 uppercase"
              />
              <span className="text-xs leading-relaxed text-cream-100/70">
                {t('home.joinCodeHint')} {t('home.codeExample')}
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cream-100/80">
                {t('home.nicknameLabel')}
              </span>
              <input
                type="text"
                data-testid="join-nickname"
                value={joinNickname}
                maxLength={20}
                autoComplete="off"
                onChange={(event) => setJoinNickname(event.target.value)}
                className="min-h-11 min-w-0 rounded-md border border-gold-300/50 bg-felt-950 px-3 py-2 text-cream-100"
              />
            </label>
            <button
              type="submit"
              data-testid="join-room"
              disabled={busy}
              className="min-h-11 rounded-md border border-gold-300/70 bg-felt-800 px-4 py-2 text-sm font-semibold text-gold-200 transition-colors hover:bg-felt-700 disabled:opacity-50"
            >
              {t('home.joinButton')}
            </button>
          </form>
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-gold-300">
        <span
          aria-hidden="true"
          className="casino-glow-neon h-1.5 w-1.5 rounded-full bg-neon-400"
        />
        {t('home.genreCatalogue', { count: genres.length })}
      </p>
    </div>
  );
}
