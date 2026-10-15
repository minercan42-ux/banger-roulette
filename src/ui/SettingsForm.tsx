import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectSettings, type SettingsView } from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { nicknameKey } from '../shared/primitives';
import type { Settings } from '../shared/settings';

type GenreMode = Settings['genre']['mode'];
type LinkedPoints = Settings['linkedPoints'];

interface GenreDraft {
  /** Local React key only; the wire id is derived deterministically on save. */
  key: string;
  de: string;
  en: string;
}

interface Draft {
  mode: GenreMode;
  rounds: number;
  submissionSeconds: number;
  clipSeconds: number;
  votingSeconds: number;
  anonymous: boolean;
  genreFailPenalty: number;
  linkedPoints: LinkedPoints;
  custom: GenreDraft[];
  fixed: GenreDraft;
}

const BOUNDS = {
  rounds: { min: 1, max: 20 },
  submissionSeconds: { min: 30, max: 300 },
  clipSeconds: { min: 15, max: 60 },
  votingSeconds: { min: 30, max: 180 },
  genreFailPenalty: { min: -10, max: -1 },
} as const;

/** Penalty restored when the host switches genre-fail back on (SPEC §5.2). */
const GENRE_FAIL_DEFAULT = -3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function draftFromSettings(view: SettingsView): Draft {
  return {
    mode: view.genreMode,
    rounds: view.rounds,
    submissionSeconds: view.submissionSeconds,
    clipSeconds: view.clipSeconds,
    votingSeconds: view.votingSeconds,
    anonymous: view.anonymous,
    genreFailPenalty: view.genreFailPenalty,
    linkedPoints: view.linkedPoints,
    custom: view.customItems.map((item, index) => ({
      key: `c${index}`,
      de: item.de,
      en: item.en,
    })),
    fixed: view.fixedGenre
      ? { key: 'f', de: view.fixedGenre.de, en: view.fixedGenre.en }
      : { key: 'f', de: '', en: '' },
  };
}

function nextCustomKey(items: readonly GenreDraft[]): string {
  let max = -1;
  for (const item of items) {
    const parsed = Number.parseInt(item.key.slice(1), 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return `c${max + 1}`;
}

/** Deterministic wire id derived from the entered labels, never a title key. */
function slugId(
  prefix: string,
  de: string,
  en: string,
  used: Set<string>,
): string {
  const slug =
    (de.trim() || en.trim())
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .slice(0, 60) || 'genre';
  let id = `${prefix}-${slug}`.slice(0, 80);
  let suffix = 1;
  while (used.has(id)) {
    id = `${prefix}-${slug}-${suffix}`.slice(0, 80);
    suffix += 1;
  }
  used.add(id);
  return id;
}

function validateDraft(draft: Draft): string | null {
  if (draft.mode === 'custom') {
    if (draft.custom.length < 2) {
      return 'settings.customNeedTwo';
    }
    const names: string[] = [];
    for (const item of draft.custom) {
      const de = item.de.trim();
      const en = item.en.trim();
      if (de.length === 0 || en.length === 0) {
        return 'settings.invalid';
      }
      names.push(nicknameKey(de), nicknameKey(en));
    }
    if (new Set(names).size !== names.length) {
      return 'settings.customUnique';
    }
  }
  if (draft.mode === 'fixed') {
    if (
      draft.fixed.de.trim().length === 0 ||
      draft.fixed.en.trim().length === 0
    ) {
      return 'settings.invalid';
    }
  }
  return null;
}

function toSettings(draft: Draft): Settings {
  const used = new Set<string>();
  const genre: Settings['genre'] =
    draft.mode === 'roulette'
      ? { mode: 'roulette' }
      : draft.mode === 'custom'
        ? {
            mode: 'custom',
            items: draft.custom.map((item) => ({
              id: slugId('custom', item.de, item.en, used),
              de: item.de.trim().normalize('NFKC'),
              en: item.en.trim().normalize('NFKC'),
            })),
          }
        : {
            mode: 'fixed',
            genre: {
              id: slugId('fixed', draft.fixed.de, draft.fixed.en, used),
              de: draft.fixed.de.trim().normalize('NFKC'),
              en: draft.fixed.en.trim().normalize('NFKC'),
            },
          };
  return {
    genre,
    rounds: draft.rounds,
    submissionSeconds: draft.submissionSeconds,
    clipSeconds: draft.clipSeconds,
    votingSeconds: draft.votingSeconds,
    anonymous: draft.anonymous,
    genreFailPenalty: draft.genreFailPenalty,
    linkedPoints: draft.linkedPoints,
  };
}

interface SettingsFormProps {
  session: GameSession;
  state: GameState;
  canEdit: boolean;
}

export function SettingsForm({ session, state, canEdit }: SettingsFormProps) {
  const { t } = useTranslation();
  const [edited, setEdited] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Server settings show through until the user edits; local edits then win
  // and are only reset after a successful save, so a new snapshot never
  // clobbers an in-progress draft.
  const draft = edited ?? draftFromSettings(selectSettings(state));
  const dirty = edited !== null;

  function update(patch: Partial<Draft>) {
    setErrorKey(null);
    setEdited({ ...draft, ...patch });
  }

  function updateCustom(index: number, patch: Partial<GenreDraft>) {
    setErrorKey(null);
    setEdited({
      ...draft,
      custom: draft.custom.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  }

  async function save() {
    const validation = validateDraft(draft);
    if (validation) {
      setErrorKey(validation);
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await session.dispatch({
        type: 'SET_SETTINGS',
        settings: toSettings(draft),
      });
      if (result.status === 'rejected') {
        setErrorKey(`errors.${result.reason}`);
        return;
      }
      setEdited(null);
    } catch {
      setErrorKey('errors.CONNECTION_FAILED');
    } finally {
      setBusy(false);
    }
  }

  const validation = validateDraft(draft);
  const disabled = !canEdit || busy;
  const genreFailEnabled = draft.genreFailPenalty !== 0;
  const statusText = busy
    ? t('settings.saving')
    : errorKey
      ? t(errorKey)
      : dirty
        ? t('settings.unsaved')
        : t('settings.saved');

  return (
    <section
      data-testid="settings-section"
      className="rounded-xl border border-gold-400/20 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('settings.heading')}
        </h2>
        <span
          data-testid="settings-status"
          data-state={
            busy ? 'saving' : errorKey ? 'error' : dirty ? 'dirty' : 'saved'
          }
          className="text-xs text-cream-100/70"
        >
          {statusText}
        </span>
      </div>
      {!canEdit && (
        <p className="mt-2 text-xs text-cream-100/60">
          {t('lobby.settingsHostOnly')}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">{t('settings.modeLabel')}</span>
          <select
            data-testid="settings-genre-mode"
            value={draft.mode}
            disabled={disabled}
            onChange={(event) =>
              update({ mode: event.target.value as GenreMode })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          >
            <option value="roulette">{t('settings.modeRoulette')}</option>
            <option value="custom">{t('settings.modeCustom')}</option>
            <option value="fixed">{t('settings.modeFixed')}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">{t('settings.rounds')}</span>
          <input
            type="number"
            data-testid="settings-rounds"
            min={BOUNDS.rounds.min}
            max={BOUNDS.rounds.max}
            step={1}
            value={draft.rounds}
            disabled={disabled}
            onChange={(event) =>
              update({
                rounds: clamp(
                  Number(event.target.value),
                  BOUNDS.rounds.min,
                  BOUNDS.rounds.max,
                ),
              })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">
            {t('settings.submissionSeconds')}
          </span>
          <input
            type="number"
            data-testid="settings-submission-seconds"
            min={BOUNDS.submissionSeconds.min}
            max={BOUNDS.submissionSeconds.max}
            step={1}
            value={draft.submissionSeconds}
            disabled={disabled}
            onChange={(event) =>
              update({
                submissionSeconds: clamp(
                  Number(event.target.value),
                  BOUNDS.submissionSeconds.min,
                  BOUNDS.submissionSeconds.max,
                ),
              })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">{t('settings.clipSeconds')}</span>
          <input
            type="number"
            data-testid="settings-clip-seconds"
            min={BOUNDS.clipSeconds.min}
            max={BOUNDS.clipSeconds.max}
            step={1}
            value={draft.clipSeconds}
            disabled={disabled}
            onChange={(event) =>
              update({
                clipSeconds: clamp(
                  Number(event.target.value),
                  BOUNDS.clipSeconds.min,
                  BOUNDS.clipSeconds.max,
                ),
              })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">
            {t('settings.votingSeconds')}
          </span>
          <input
            type="number"
            data-testid="settings-voting-seconds"
            min={BOUNDS.votingSeconds.min}
            max={BOUNDS.votingSeconds.max}
            step={1}
            value={draft.votingSeconds}
            disabled={disabled}
            onChange={(event) =>
              update({
                votingSeconds: clamp(
                  Number(event.target.value),
                  BOUNDS.votingSeconds.min,
                  BOUNDS.votingSeconds.max,
                ),
              })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          />
        </label>

        <div
          role="group"
          aria-labelledby="settings-genre-fail-heading"
          className="flex flex-col gap-1 text-sm"
        >
          <span id="settings-genre-fail-heading" className="text-cream-100/80">
            {t('settings.genreFailPenalty')}
          </span>
          <label className="flex items-center gap-2 text-xs text-cream-100/70">
            <input
              type="checkbox"
              data-testid="settings-genre-fail-enabled"
              aria-labelledby="settings-genre-fail-heading settings-genre-fail-toggle"
              aria-describedby="settings-genre-fail-help"
              checked={genreFailEnabled}
              disabled={disabled}
              onChange={(event) =>
                update({
                  genreFailPenalty: event.target.checked
                    ? GENRE_FAIL_DEFAULT
                    : 0,
                })
              }
              className="size-4 accent-gold-400"
            />
            <span id="settings-genre-fail-toggle">
              {t('settings.genreFailEnabled')}
            </span>
          </label>
          <input
            type="number"
            data-testid="settings-genre-fail-penalty"
            aria-labelledby="settings-genre-fail-heading"
            aria-describedby="settings-genre-fail-help"
            min={BOUNDS.genreFailPenalty.min}
            max={BOUNDS.genreFailPenalty.max}
            step={1}
            value={genreFailEnabled ? draft.genreFailPenalty : ''}
            disabled={disabled || !genreFailEnabled}
            onChange={(event) =>
              update({
                genreFailPenalty: clamp(
                  Number(event.target.value),
                  BOUNDS.genreFailPenalty.min,
                  BOUNDS.genreFailPenalty.max,
                ),
              })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          />
          {genreFailEnabled ? (
            <span
              id="settings-genre-fail-help"
              className="text-xs text-cream-100/50"
            >
              {t('settings.genreFailPenaltyHint')}
            </span>
          ) : (
            <span
              id="settings-genre-fail-help"
              data-testid="settings-genre-fail-off"
              className="text-xs text-cream-100/50"
            >
              {t('settings.genreFailOff')}
            </span>
          )}
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-cream-100/80">
            {t('settings.linkedPoints')}
          </span>
          <select
            data-testid="settings-linked-points"
            value={draft.linkedPoints}
            disabled={disabled}
            onChange={(event) =>
              update({ linkedPoints: event.target.value as LinkedPoints })
            }
            className="casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
          >
            <option value="full">{t('settings.linkedPointsFull')}</option>
            <option value="halfCeil">
              {t('settings.linkedPointsHalfCeil')}
            </option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="settings-anonymous"
            checked={draft.anonymous}
            disabled={disabled}
            onChange={(event) => update({ anonymous: event.target.checked })}
            className="size-4 accent-gold-400"
          />
          <span className="text-cream-100/80">{t('settings.anonymous')}</span>
        </label>
      </div>

      {draft.mode === 'custom' && (
        <div data-testid="settings-custom-items" className="mt-4 space-y-2">
          <p className="text-xs text-cream-100/60">
            {t('settings.customCount', { total: draft.custom.length })}
          </p>
          {draft.custom.map((item, index) => (
            <div
              key={item.key}
              data-testid="settings-custom-row"
              className="flex flex-wrap items-end gap-2"
            >
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                <span className="text-cream-100/70">
                  {t('settings.customDe')}
                </span>
                <input
                  type="text"
                  data-testid="settings-custom-de"
                  value={item.de}
                  disabled={disabled}
                  maxLength={80}
                  onChange={(event) =>
                    updateCustom(index, { de: event.target.value })
                  }
                  className="min-w-0 casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                <span className="text-cream-100/70">
                  {t('settings.customEn')}
                </span>
                <input
                  type="text"
                  data-testid="settings-custom-en"
                  value={item.en}
                  disabled={disabled}
                  maxLength={80}
                  onChange={(event) =>
                    updateCustom(index, { en: event.target.value })
                  }
                  className="min-w-0 casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
                />
              </label>
              <button
                type="button"
                data-testid="settings-custom-remove"
                disabled={disabled}
                onClick={() =>
                  update({
                    custom: draft.custom.filter(
                      (_entry, position) => position !== index,
                    ),
                  })
                }
                className="rounded-md border border-rose-400/40 px-2 py-1 text-xs text-rose-200 disabled:opacity-50"
              >
                {t('settings.customRemove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            data-testid="settings-custom-add"
            disabled={disabled || draft.custom.length >= 50}
            onClick={() =>
              update({
                custom: [
                  ...draft.custom,
                  { key: nextCustomKey(draft.custom), de: '', en: '' },
                ],
              })
            }
            className="rounded-md border border-gold-400/40 px-3 py-1 text-xs text-cream-100 disabled:opacity-50"
          >
            {t('settings.customAdd')}
          </button>
        </div>
      )}

      {draft.mode === 'fixed' && (
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span className="text-cream-100/70">{t('settings.fixedDe')}</span>
            <input
              type="text"
              data-testid="settings-fixed-de"
              value={draft.fixed.de}
              disabled={disabled}
              maxLength={80}
              onChange={(event) =>
                update({ fixed: { ...draft.fixed, de: event.target.value } })
              }
              className="min-w-0 casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span className="text-cream-100/70">{t('settings.fixedEn')}</span>
            <input
              type="text"
              data-testid="settings-fixed-en"
              value={draft.fixed.en}
              disabled={disabled}
              maxLength={80}
              onChange={(event) =>
                update({ fixed: { ...draft.fixed, en: event.target.value } })
              }
              className="min-w-0 casino-field rounded-md border bg-felt-950 px-2 py-1 text-cream-100 disabled:opacity-60"
            />
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="settings-save"
          onClick={() => {
            void save();
          }}
          disabled={disabled || !dirty || validation !== null}
          className="rounded-md border border-gold-400/50 bg-gold-500/20 px-3 py-2 text-sm text-cream-100 transition hover:bg-gold-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('settings.save')}
        </button>
        {errorKey && (
          <span
            data-testid="settings-error"
            role="alert"
            className="text-xs text-rose-300"
          >
            {t(errorKey)}
          </span>
        )}
      </div>
    </section>
  );
}
