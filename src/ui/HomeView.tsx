import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import genres from '../content/genres.json';
import type { SessionError } from '../net/errors';
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
    <div data-testid="home-view" className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-semibold text-cream-100 sm:text-3xl">
          {t('home.heading')}
        </h1>
        <p className="mt-2 text-sm text-cream-100/80">{t('home.intro')}</p>
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
          className="space-y-5"
        >
          {identityMissing && (
            <p
              data-testid="identity-missing"
              role="status"
              className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
            >
              {t('home.identityMissing')}
            </p>
          )}

          {errorKey && (
            <p
              data-testid="home-error"
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
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
            className="space-y-2 rounded-xl border border-gold-400/20 bg-felt-800/50 p-4"
          >
            <h2 className="font-display text-lg text-gold-300">
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
                className="rounded-md border border-gold-400/40 bg-felt-950 px-3 py-2 text-cream-100"
              />
              <span className="text-xs text-cream-100/50">
                {t('home.nicknameHint')}
              </span>
            </label>
            <button
              type="submit"
              data-testid="create-room"
              disabled={busy}
              className="rounded-md border border-gold-400/50 bg-gold-500/20 px-4 py-2 text-sm text-cream-100 transition hover:bg-gold-500/30 disabled:opacity-50"
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
            className="space-y-2 rounded-xl border border-gold-400/20 bg-felt-800/50 p-4"
          >
            <h2 className="font-display text-lg text-gold-300">
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
                className="rounded-md border border-gold-400/40 bg-felt-950 px-3 py-2 font-mono tracking-[0.3em] text-cream-100 uppercase"
              />
              <span className="text-xs text-cream-100/50">
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
                className="rounded-md border border-gold-400/40 bg-felt-950 px-3 py-2 text-cream-100"
              />
            </label>
            <button
              type="submit"
              data-testid="join-room"
              disabled={busy}
              className="rounded-md border border-gold-400/50 bg-gold-500/20 px-4 py-2 text-sm text-cream-100 transition hover:bg-gold-500/30 disabled:opacity-50"
            >
              {t('home.joinButton')}
            </button>
          </form>
        </div>
      )}

      <p className="text-xs text-gold-300/80">
        {t('home.genreCatalogue', { count: genres.length })}
      </p>
    </div>
  );
}
