import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import genres from '../content/genres.json';
import type { SessionError } from '../net/errors';
import { normalizeRoomCode, ROOM_CODE_PATTERN } from './format';
import { Button } from './pf/Button';
import { Chip } from './pf/Chip';
import { Field } from './pf/Field';
import { Panel, PanelTitle } from './pf/Panel';

interface HomeViewProps {
  prefillCode: string | null;
  joining: boolean;
  identityMissing: boolean;
  onCreate: (nickname: string) => Promise<SessionError | null>;
  onJoin: (code: string, nickname: string) => Promise<SessionError | null>;
}

type FormName = 'create' | 'join';

interface Failure {
  key: string;
  form: FormName;
}

/** Errors that point at the room code field / the nickname field. */
const CODE_ERRORS = new Set([
  'errors.INVALID_ROOM_CODE',
  'errors.ROOM_NOT_FOUND',
]);
const NICKNAME_ERRORS = new Set(['errors.INVALID', 'errors.NICKNAME_TAKEN']);

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
  const [failure, setFailure] = useState<Failure | null>(null);

  const errorKey = failure?.key ?? null;
  const nicknameInvalid = (form: FormName) =>
    failure?.form === form && NICKNAME_ERRORS.has(failure.key);
  const codeInvalid = failure?.form === 'join' && CODE_ERRORS.has(failure.key);

  async function submitCreate() {
    if (nicknameError(nickname)) {
      setFailure({ key: 'errors.INVALID', form: 'create' });
      return;
    }
    setBusy(true);
    setFailure(null);
    const error = await onCreate(nickname.trim());
    if (error) {
      setFailure({ key: `errors.${error}`, form: 'create' });
    }
    setBusy(false);
  }

  async function submitJoin() {
    if (!ROOM_CODE_PATTERN.test(code)) {
      setFailure({ key: 'errors.INVALID_ROOM_CODE', form: 'join' });
      return;
    }
    if (nicknameError(joinNickname)) {
      setFailure({ key: 'errors.INVALID', form: 'join' });
      return;
    }
    setBusy(true);
    setFailure(null);
    const error = await onJoin(code, joinNickname.trim());
    if (error) {
      setFailure({ key: `errors.${error}`, form: 'join' });
    }
    setBusy(false);
  }

  return (
    <div data-testid="home-view" className="space-y-5">
      <div>
        <PanelTitle as="h1">{t('home.heading')}</PanelTitle>
        <p className="br-read">{t('home.intro')}</p>
      </div>

      {joining && (
        <p data-testid="route-joining" className="br-notice">
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
              className="br-notice"
            >
              {t('home.identityMissing')}
            </p>
          )}

          {errorKey && (
            <p
              data-testid="home-error"
              role="alert"
              className="br-notice br-notice--error"
            >
              {t(errorKey)}
            </p>
          )}

          <Panel
            as="form"
            data-testid="create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCreate();
            }}
            className="space-y-3"
          >
            <PanelTitle className="flex items-center gap-2">
              <Chip tone="gold" size="sm" />
              {t('home.createHeading')}
            </PanelTitle>
            <Field
              type="text"
              data-testid="create-nickname"
              label={t('home.nicknameLabel')}
              hint={t('home.nicknameHint')}
              invalid={nicknameInvalid('create')}
              value={nickname}
              maxLength={20}
              autoComplete="off"
              onChange={(event) => setNickname(event.target.value)}
            />
            <Button type="submit" data-testid="create-room" disabled={busy}>
              {t('home.createButton')}
            </Button>
          </Panel>

          <Panel
            as="form"
            data-testid="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitJoin();
            }}
            className="space-y-3"
          >
            <PanelTitle className="flex items-center gap-2">
              <Chip tone="blue" size="sm" />
              {t('home.joinHeading')}
            </PanelTitle>
            <Field
              type="text"
              data-testid="join-code"
              label={t('home.joinCodeLabel')}
              hint={`${t('home.joinCodeHint')} ${t('home.codeExample')}`}
              invalid={codeInvalid}
              value={code}
              maxLength={6}
              autoComplete="off"
              inputMode="text"
              onChange={(event) =>
                setCode(normalizeRoomCode(event.target.value))
              }
              className="br-field--code"
            />
            <Field
              type="text"
              data-testid="join-nickname"
              label={t('home.nicknameLabel')}
              invalid={nicknameInvalid('join')}
              value={joinNickname}
              maxLength={20}
              autoComplete="off"
              onChange={(event) => setJoinNickname(event.target.value)}
            />
            <Button
              type="submit"
              tone="blue"
              data-testid="join-room"
              disabled={busy}
            >
              {t('home.joinButton')}
            </Button>
          </Panel>
        </div>
      )}

      <p className="br-label">
        {t('home.genreCatalogue', { count: genres.length })}
      </p>
    </div>
  );
}
