import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectPlayback,
  selectRatingEntries,
  selectViewerChoices,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import type { GameState } from '../shared/game';
import { Panel } from './pf/Panel';
import { RatingBar } from './RatingBar';

interface RatingSectionProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
  viewerConnectionId: string | null;
}

/**
 * FR-40 live rating: the chip bar for the playing song and, below it, the
 * viewer's own ratings of the songs that already played (tap one to change it
 * until PLAYBACK ends). Owners see "your song" instead of a bar. Only the
 * viewer's own ratings are ever shown; nobody sees the others' values before
 * the reveal.
 */
export function RatingSection({
  session,
  state,
  viewerId,
  viewerConnectionId,
}: RatingSectionProps) {
  const { t } = useTranslation();
  const view = selectPlayback(state, viewerId, viewerConnectionId);
  const entries = selectRatingEntries(state, viewerId, viewerConnectionId);
  const choices = selectViewerChoices(state, viewerId);
  const [editing, setEditing] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);

  if (view === null || !choices.isParticipant) {
    return null;
  }

  async function rate(songId: string, value: number) {
    setNoticeKey(null);
    const result = await session.dispatch({ type: 'RATE', songId, value });
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
    }
  }

  const current = entries.find((entry) => entry.isCurrent);
  const played = entries.filter((entry) => !entry.isCurrent);

  return (
    <div className="br-stack" data-testid="rating-section">
      {current?.ownedByViewer ? (
        <p data-testid="rating-own" className="br-notice">
          {t('rating.ownSong')}
        </p>
      ) : (
        <div className="br-stack">
          <RatingBar
            testId="rating-bar"
            chipTestId="rating-chip"
            label={t('rating.groupLabel', {
              number: view.index + 1,
              title: view.song.title,
            })}
            value={view.rating}
            disabled={!view.canRate}
            onRate={(value) => {
              void rate(view.song.videoId, value);
            }}
          />
          <p
            data-testid="rating-current"
            data-rating={view.rating ?? ''}
            role="status"
            className="br-read"
          >
            {view.rating === null
              ? t('rating.unrated')
              : view.rating === 0
                ? t('rating.currentGenreFail')
                : t('rating.current', { value: view.rating })}
          </p>
        </div>
      )}

      {noticeKey && (
        <p data-testid="rating-notice" role="status" className="br-notice">
          {t(noticeKey)}
        </p>
      )}

      {played.length > 0 && (
        <section
          data-testid="rating-summary"
          aria-labelledby="rating-summary-heading"
          className="br-stack"
        >
          <h3 id="rating-summary-heading" className="br-label">
            {t('rating.summaryHeading')}
          </h3>
          <ul className="br-ratelist">
            {played.map((entry) => {
              const open = editing === entry.videoId;
              const title = t('rating.entryTitle', {
                number: entry.index + 1,
                title: entry.title,
              });
              const value = entry.ownedByViewer
                ? t('rating.ownShort')
                : entry.rating === null
                  ? t('rating.none')
                  : entry.rating === 0
                    ? t('rating.genreFailShort')
                    : String(entry.rating);
              return (
                <Panel
                  as="li"
                  well
                  key={entry.videoId}
                  data-testid={`rating-entry-${entry.index}`}
                  data-video-id={entry.videoId}
                  data-rating={entry.rating ?? ''}
                  className="br-rateentry"
                >
                  {entry.canRate ? (
                    <button
                      type="button"
                      data-testid={`rating-entry-toggle-${entry.index}`}
                      aria-expanded={open}
                      onClick={() => {
                        setEditing(open ? null : entry.videoId);
                      }}
                      className="br-rateentry__head"
                    >
                      <span className="br-rateentry__title br-read">
                        {title}
                      </span>
                      <span className="br-rateentry__value">{value}</span>
                    </button>
                  ) : (
                    <div className="br-rateentry__head">
                      <span className="br-rateentry__title br-read">
                        {title}
                      </span>
                      <span className="br-rateentry__value">{value}</span>
                    </div>
                  )}
                  {open && entry.canRate && (
                    <RatingBar
                      testId="rating-edit-bar"
                      chipTestId="rating-edit-chip"
                      label={t('rating.groupLabel', {
                        number: entry.index + 1,
                        title: entry.title,
                      })}
                      value={entry.rating}
                      disabled={false}
                      onRate={(next) => {
                        void rate(entry.videoId, next);
                      }}
                    />
                  )}
                </Panel>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
