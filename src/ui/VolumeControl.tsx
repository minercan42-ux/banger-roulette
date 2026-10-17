import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_VOLUME, useVolumeStore } from './volume-store';

type SpeakerLevel = 'muted' | 'low' | 'high';

/** Below this volume the speaker shows one wave instead of two. */
const LOW_BELOW = 50;

/**
 * Pixel speaker on a 12 x 12 grid, drawn as whole cells and scaled by two so
 * the edges stay sharp (Pixel-Filz: shapes, no icon set). The cone and the
 * waves are `currentColor`; the muted state swaps the waves for a cross, so the
 * state never rides on colour alone.
 */
function SpeakerIcon({ level }: { level: SpeakerLevel }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="24"
      height="24"
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      fill="currentColor"
      className="br-volume__speaker"
    >
      <rect x="0" y="4" width="3" height="4" />
      <rect x="3" y="3" width="1" height="6" />
      <rect x="4" y="2" width="1" height="8" />
      <rect x="5" y="1" width="1" height="10" />
      {level === 'muted' ? (
        <>
          <rect x="7" y="4" width="1" height="1" />
          <rect x="11" y="4" width="1" height="1" />
          <rect x="8" y="5" width="1" height="1" />
          <rect x="10" y="5" width="1" height="1" />
          <rect x="9" y="6" width="1" height="1" />
          <rect x="8" y="7" width="1" height="1" />
          <rect x="10" y="7" width="1" height="1" />
          <rect x="7" y="8" width="1" height="1" />
          <rect x="11" y="8" width="1" height="1" />
        </>
      ) : (
        <>
          <rect x="7" y="4" width="1" height="1" />
          <rect x="8" y="5" width="1" height="2" />
          <rect x="7" y="7" width="1" height="1" />
          {level === 'high' && (
            <>
              <rect x="9" y="2" width="1" height="1" />
              <rect x="10" y="3" width="1" height="6" />
              <rect x="9" y="9" width="1" height="1" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

/** Pixel chevron on a 7 x 4 grid; points down closed, up while the popover is open. */
function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="14"
      height="8"
      viewBox="0 0 7 4"
      shapeRendering="crispEdges"
      fill="currentColor"
      className={`br-volume__caret-icon${open ? ' is-open' : ''}`}
    >
      <rect x="0" y="0" width="1" height="1" />
      <rect x="6" y="0" width="1" height="1" />
      <rect x="1" y="1" width="1" height="1" />
      <rect x="5" y="1" width="1" height="1" />
      <rect x="2" y="2" width="1" height="1" />
      <rect x="4" y="2" width="1" height="1" />
      <rect x="3" y="3" width="1" height="1" />
    </svg>
  );
}

/**
 * Top-bar volume control (issue #107). A speaker button toggles mute, the
 * chevron beside it opens a small popover with the 0-100 slider and a mute
 * checkbox. The value lives in `volume-store`, so it reaches the room player
 * and the submission preview in every phase. The popover stays mounted while
 * closed (hidden) so `aria-controls` always resolves; Esc, an outside press or
 * moving focus out of the control closes it.
 */
export function VolumeControl() {
  const { t } = useTranslation();
  const volume = useVolumeStore((store) => store.volume);
  const muted = useVolumeStore((store) => store.muted);
  const setVolume = useVolumeStore((store) => store.setVolume);
  const setMuted = useVolumeStore((store) => store.setMuted);
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const silent = muted || volume === 0;
  const level: SpeakerLevel = silent
    ? 'muted'
    : volume < LOW_BELOW
      ? 'low'
      : 'high';

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        openerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target) !== true
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  function toggleMute() {
    if (silent) {
      // A speaker that shows "off" must come back audible: lift a zero volume.
      if (volume === 0) {
        setVolume(DEFAULT_VOLUME);
      }
      setMuted(false);
    } else {
      setMuted(true);
    }
  }

  return (
    <div
      ref={rootRef}
      data-testid="volume-control"
      className="br-volume"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <div className="br-volume__group">
        <button
          type="button"
          data-testid="playback-mute"
          data-muted={muted}
          data-level={level}
          aria-pressed={silent}
          aria-label={t('volume.mute')}
          onClick={toggleMute}
          className="br-btn br-btn--sm br-btn--slate br-volume__icon"
        >
          <SpeakerIcon level={level} />
        </button>
        <button
          ref={openerRef}
          type="button"
          data-testid="volume-toggle"
          aria-label={t('volume.open')}
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="br-btn br-btn--sm br-btn--slate br-volume__caret"
        >
          <CaretIcon open={open} />
        </button>
      </div>
      <div
        id={popoverId}
        role="group"
        aria-label={t('volume.label')}
        hidden={!open}
        data-testid="volume-popover"
        className="br-volume__pop"
      >
        <div className="br-volume__row">
          <label htmlFor={`${popoverId}-slider`} className="br-volume__label">
            {t('volume.label')}
          </label>
          <output
            htmlFor={`${popoverId}-slider`}
            data-testid="volume-value"
            className="br-volume__value"
          >
            {volume}
          </output>
        </div>
        <input
          id={`${popoverId}-slider`}
          type="range"
          min={0}
          max={100}
          step={1}
          data-testid="playback-volume"
          data-value={volume}
          value={volume}
          aria-valuetext={t('volume.valueText', { value: volume })}
          style={{ '--br-volume': volume } as CSSProperties}
          onChange={(event) => {
            setVolume(Number(event.target.value));
          }}
          className="br-volume__slider"
        />
        <label className="br-check">
          <input
            type="checkbox"
            data-testid="volume-popover-mute"
            checked={muted}
            onChange={(event) => {
              setMuted(event.target.checked);
            }}
            className="br-check__input"
          />
          <span>{t('volume.mute')}</span>
        </label>
      </div>
    </div>
  );
}
