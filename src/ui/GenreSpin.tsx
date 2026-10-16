import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectGenrePool,
  selectPhaseTimer,
  selectRoom,
  selectSettings,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { genreName } from './format';
import { usePrefersReducedMotion } from './motion';
import { GenrePlate } from './pf/GenrePlate';
import {
  genreTargetAngle,
  reelAngle,
  reelRows,
  reelTicks,
  reelTimeline,
  REEL_TICK_MS,
} from './reel';
import { useSessionNow } from './use-session-now';

interface GenreSpinProps {
  session: GameSession;
  state: GameState;
}

/** Frame cadence of the spin; the reel is the only moving thing on screen. */
const FRAME_MS = 16;

/** One drum row; the angle and the name length drive the stylesheet. */
interface RowStyle extends CSSProperties {
  '--phi': string;
  '--len': number;
}

/**
 * FR-10 genre roulette as a reel seen from the side (a slot machine drum).
 * The result is already in the snapshot; the animation only derives its drum
 * angle from the shared phase clock (`reel.ts`), so a late mount, a reload or
 * a pause freezes on the same angle instead of rerolling.
 *
 * Timeline (`reelTimeline`): the drum decelerates over 3200 ms and the
 * pointers nudge at every row that passes the window; at the stop the stage
 * shakes for 420 ms while the window flashes gold, a light sweep crosses it
 * and the genre plate pops in. The result then stays until the phase ends (at
 * least 2 s). Fixed mode shows the plate straight away. Reduced motion: no
 * spin, no shake, the drum stands on the result and the plate fades in at once.
 */
export function GenreSpin({ session, state }: GenreSpinProps) {
  const { t, i18n } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const room = selectRoom(state);
  const genrePool = state.genrePool;
  // The selector clones the pool; key the copy on the pool identity so the
  // row names only rebuild when the pool itself changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- genrePool is the identity of `state`'s pool
  const pool = useMemo(() => selectGenrePool(state), [genrePool]);
  const genre = room.genre;
  const spinMode = selectSettings(state).genreMode !== 'fixed';
  // The clock only runs for the spin itself; the hold afterwards is static.
  const spinning = spinMode && !reducedMotion;
  const now = useSessionNow(session, spinning, FRAME_MS);
  const timer = selectPhaseTimer(state, now);

  const totalMs = timer.totalMs ?? 0;
  const elapsed =
    timer.totalMs !== null && timer.remainingMs !== null
      ? timer.totalMs - timer.remainingMs
      : Number.POSITIVE_INFINITY;
  const { spinMs, shakeMs } = reelTimeline(totalMs);
  const stopped = !spinMode || reducedMotion || elapsed >= spinMs;

  // The polite live region mounts empty and receives the result in a later
  // task, so it is an update (announced) even when the reel is already
  // stopped on the first render (fixed mode, reduced motion). Only `stopped`
  // and the text are dependencies: clock frames and pause/resume re-render
  // without changing them, so the text is published once per result.
  const announcementText = genre
    ? t('genre.announcement', {
        genre: genreName(genre, i18n.resolvedLanguage),
      })
    : '';
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (!stopped) {
      return undefined;
    }
    const handle = setTimeout(() => setAnnounced(announcementText), 0);
    return () => clearTimeout(handle);
  }, [stopped, announcementText]);

  if (!genre) {
    return null;
  }
  const label = genreName(genre, i18n.resolvedLanguage);
  const index = pool.findIndex((candidate) => candidate.id === genre.id);
  const targetAngle = genreTargetAngle(index, pool.length);
  const angle = reducedMotion
    ? targetAngle
    : reelAngle(elapsed, spinMs, targetAngle);
  const ticks = reelTicks(angle);
  const ticking =
    !reducedMotion && ticks > 0 && elapsed < spinMs + REEL_TICK_MS;
  const shaking =
    spinMode &&
    !reducedMotion &&
    shakeMs > 0 &&
    elapsed >= spinMs &&
    elapsed < spinMs + shakeMs;

  return (
    <section data-testid="genre-spin" className="br-spin">
      <h2 className="br-panel__title">{t('genre.heading')}</h2>

      <div
        className={`br-spin__stage${shaking ? ' br-shake' : ''}`}
        style={
          shaking
            ? {
                animationDuration: `${shakeMs}ms`,
                animationDelay: `${spinMs - elapsed}ms`,
              }
            : undefined
        }
      >
        {spinMode ? (
          <>
            <div
              data-testid="genre-wheel"
              data-genre-id={genre.id}
              data-target-angle={Math.round(targetAngle)}
              role="img"
              aria-label={
                stopped
                  ? t('genre.announcement', { genre: label })
                  : t('genre.spinning')
              }
              className={`br-reel${stopped ? ' is-stopped' : ''}`}
            >
              <div aria-hidden="true" className="br-reel__bulbs" />
              <div aria-hidden="true" className="br-reel__view">
                <div className="br-reel__drum">
                  {reelRows(angle, pool.length).map((row) => {
                    const name = genreName(
                      pool[row.poolIndex]!,
                      i18n.resolvedLanguage,
                    );
                    const style: RowStyle = {
                      '--phi': `${(-row.degrees).toFixed(2)}deg`,
                      '--len': [...name].length,
                    };
                    return (
                      <div
                        key={row.slot}
                        className="br-reel__row"
                        data-picked={
                          stopped &&
                          row.poolIndex === index &&
                          Math.abs(row.offset) < 0.5
                            ? 'true'
                            : undefined
                        }
                        style={style}
                      >
                        {name}
                      </div>
                    );
                  })}
                </div>
                <div className="br-reel__shade" />
                <div className="br-reel__window" />
                <div
                  key={`l${ticking ? ticks : 'idle'}`}
                  className={`br-reel__pointer br-reel__pointer--left${ticking ? ' is-tick' : ''}`}
                />
                <div
                  key={`r${ticking ? ticks : 'idle'}`}
                  className={`br-reel__pointer br-reel__pointer--right${ticking ? ' is-tick' : ''}`}
                />
              </div>
              <div
                aria-hidden="true"
                className="br-reel__bulbs br-reel__bulbs--bottom"
              />
            </div>
            {!stopped && <p className="br-label">{t('genre.spinning')}</p>}
          </>
        ) : (
          <p data-testid="genre-fixed-notice" className="br-read">
            {t('genre.fixedNotice')}
          </p>
        )}

        <div className="br-spin__slot">
          {stopped && (
            <GenrePlate
              kicker={spinMode ? t('genre.kicker') : t('genre.resultLabel')}
              name={label}
              live={false}
            />
          )}
        </div>
      </div>

      <span data-testid="genre-result" className="sr-only">
        {label}
      </span>
      <span
        data-testid="genre-announcement"
        aria-live="polite"
        className="sr-only"
      >
        {stopped && announced === announcementText ? announced : ''}
      </span>
    </section>
  );
}
