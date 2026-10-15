import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectEligibleSongs,
  selectFlaggableSongs,
  selectSongs,
  selectViewerChoices,
  selectViewerPermissions,
  selectRoom,
  type PlayerView,
  type SongView,
} from '../engine/selectors';
import type { GameSession } from '../net/session';
import {
  createPreview,
  PreviewError,
  type PreviewPlayer,
  type PreviewStatus,
} from '../player/preview';
import type { GameState } from '../shared/game';
import { useEmbedConsent } from './embed-consent';
import { Button } from './pf/Button';
import { Panel, PanelTitle } from './pf/Panel';
import { SongCard } from './pf/SongCard';
import { PhaseTimer } from './pf/Stat';
import {
  appendToRanking,
  insertRanking,
  moveRanking,
  removeFromRanking,
  reorderRanking,
} from './ranking';

interface VotingPhaseProps {
  session: GameSession;
  state: GameState;
  viewerId: string;
  viewerConnectionId: string | null;
  roster: PlayerView[];
}

type ListenStatus = PreviewStatus | 'idle' | 'loading';

interface Announcement {
  key: string;
  values: Record<string, string | number>;
}

/** Human label for the local re-listen status (FR-40). */
function listenStatusKey(status: ListenStatus): string {
  if (status === 'idle' || status === 'loading') {
    return status === 'idle' ? 'voting.statusIdle' : 'voting.statusLoading';
  }
  switch (status.type) {
    case 'ready':
      return 'voting.statusReady';
    case 'playing':
      return 'voting.statusPlaying';
    case 'autoplayBlocked':
      return 'voting.statusAutoplayBlocked';
    default:
      return 'voting.statusError';
  }
}

/**
 * FR-40..FR-42 voting view. The ranking is the viewer's intent: it is seeded
 * from the server ballot, kept locally while a SET_RANKING command is in flight
 * and re-synced whenever the server ballot changes with no pending local edit.
 * Every discrete change (add/remove/move/drop) dispatches the full ordered list;
 * an identical ranking comes back as NOT_READY and is swallowed silently. All
 * reads go through selectors, all writes through session.dispatch. Owner names
 * stay hidden while anonymity is on (AK-3) - only `ownersVisible` is rendered.
 */
export function VotingPhase({
  session,
  state,
  viewerId,
  viewerConnectionId,
  roster,
}: VotingPhaseProps) {
  const { t } = useTranslation();
  const choices = selectViewerChoices(state, viewerId);
  const permissions = selectViewerPermissions(
    state,
    viewerId,
    viewerConnectionId,
  );
  const eligible = selectEligibleSongs(state, viewerId, viewerConnectionId);
  const flaggable = selectFlaggableSongs(state, viewerId, viewerConnectionId);
  const flaggableIds = new Set(flaggable.map((song) => song.videoId));
  const { consented, setConsent } = useEmbedConsent();

  const [ranking, setRanking] = useState<string[]>(() => choices.ranking);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [listenStatus, setListenStatus] = useState<ListenStatus>('idle');

  // The last ranking we sent, still awaiting its snapshot. `null` means no local
  // edit is pending and the server ballot may overwrite the local order.
  const pendingRef = useRef<string[] | null>(null);
  const dragRef = useRef<{ from: 'pool' | 'rank'; videoId: string } | null>(
    null,
  );
  const previewRef = useRef<{
    generation: number;
    abort: AbortController | null;
    player: PreviewPlayer | null;
    host: HTMLDivElement | null;
  }>({ generation: 0, abort: null, player: null, host: null });

  const teardownPreview = useCallback(() => {
    previewRef.current.generation += 1;
    previewRef.current.abort?.abort();
    previewRef.current.abort = null;
    previewRef.current.player?.destroy();
    previewRef.current.player = null;
  }, []);

  // FR-40: the local preview is destroyed on unmount (the phase switch unmounts
  // this component) and on every song switch through `listen`.
  useEffect(() => teardownPreview, [teardownPreview]);

  // Re-sync the local order with the server ballot, but never while a local edit
  // is waiting for its snapshot (FR-40: keep the local order if the snapshot lags).
  useEffect(() => {
    const server = selectViewerChoices(state, viewerId).ranking;
    const serverKey = server.join(',');
    if (pendingRef.current !== null) {
      if (pendingRef.current.join(',') === serverKey) {
        pendingRef.current = null;
      }
      return;
    }
    setRanking((current) =>
      current.join(',') === serverKey ? current : server,
    );
  }, [state, viewerId]);

  const editable = permissions.canRank;
  // The ranking is resolved against all round songs, so a finished voter still
  // sees their order read-only (selectEligibleSongs is empty once voting is done).
  const allSongs = selectSongs(state, viewerId);
  const ranked = ranking
    .map((videoId) => allSongs.find((song) => song.videoId === videoId))
    .filter((song): song is SongView => song !== undefined);
  // A pause empties the write-target lists; keep showing an active voter the
  // foreign songs read-only instead of claiming there is nothing to rank.
  // Finished voters keep their unchanged read-only ballot view.
  const paused = selectRoom(state).paused;
  const unranked =
    paused && choices.isParticipant && !choices.votingDone
      ? allSongs.filter((song) => !song.ownedByViewer)
      : eligible;
  const pool = unranked.filter((song) => !ranking.includes(song.videoId));
  const participants = roster.filter((player) => player.isParticipant);
  const doneCount = participants.filter((player) => player.votingDone).length;
  const listenState =
    typeof listenStatus === 'string' ? listenStatus : listenStatus.type;

  async function commit(next: string[]) {
    if (!permissions.canRank) {
      return;
    }
    if (next.join(',') === ranking.join(',')) {
      return;
    }
    pendingRef.current = next;
    setRanking(next);
    setErrorKey(null);
    const result = await session.dispatch({
      type: 'SET_RANKING',
      ranking: next,
    });
    if (result.status !== 'rejected') {
      return;
    }
    if (result.reason !== 'NOT_READY') {
      setErrorKey(`errors.${result.reason}`);
    }
    // A newer edit superseded this command; let that one own the local order.
    if (pendingRef.current?.join(',') !== next.join(',')) {
      return;
    }
    pendingRef.current = null;
    const snapshot = session.getSnapshot();
    setRanking(
      snapshot.state
        ? selectViewerChoices(snapshot.state, viewerId).ranking
        : [],
    );
  }

  function addSong(song: SongView) {
    const next = appendToRanking(ranking, song.videoId);
    setAnnouncement({
      key: 'voting.addedAnnouncement',
      values: { title: song.title, place: next.length },
    });
    void commit(next);
  }

  function removeSong(song: SongView) {
    setAnnouncement({
      key: 'voting.removedAnnouncement',
      values: { title: song.title },
    });
    void commit(removeFromRanking(ranking, song.videoId));
  }

  function moveSong(song: SongView, delta: number) {
    const next = moveRanking(ranking, song.videoId, delta);
    setAnnouncement({
      key: 'voting.movedAnnouncement',
      values: {
        title: song.title,
        place: next.indexOf(song.videoId) + 1,
        total: next.length,
      },
    });
    void commit(next);
  }

  function onDragStart(
    event: DragEvent,
    from: 'pool' | 'rank',
    videoId: string,
  ) {
    if (!editable) {
      return;
    }
    dragRef.current = { from, videoId };
    event.dataTransfer.effectAllowed = 'move';
    // Firefox only starts a drag when some data is set.
    event.dataTransfer.setData('text/plain', videoId);
  }

  function onDragEnd() {
    dragRef.current = null;
  }

  /** Drop onto rank item `index`: insert (pool) or move (rank) to that place. */
  function dropOnRankIndex(index: number) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null || !editable) {
      return;
    }
    if (drag.from === 'rank') {
      void commit(reorderRanking(ranking, drag.videoId, index));
    } else {
      void commit(insertRanking(ranking, drag.videoId, index));
    }
  }

  /** Drop onto the ranking container: a pool song is appended at the end. */
  function dropOnRankingEnd() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null || drag.from !== 'pool' || !editable) {
      return;
    }
    const song = eligible.find(
      (candidate) => candidate.videoId === drag.videoId,
    );
    if (song === undefined) {
      return;
    }
    addSong(song);
  }

  /** Drop onto the pool: a ranked song goes back to the unranked pool. */
  function dropOnPool() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null || drag.from !== 'rank' || !editable) {
      return;
    }
    void commit(removeFromRanking(ranking, drag.videoId));
  }

  async function toggleFlag(song: SongView) {
    if (!flaggableIds.has(song.videoId)) {
      return;
    }
    const flagged = choices.flaggedVideoIds.includes(song.videoId);
    setNoticeKey(null);
    const result = await session.dispatch({
      type: 'SET_GENRE_FAIL',
      videoId: song.videoId,
      flagged: !flagged,
    });
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
    }
  }

  async function finishVoting() {
    if (!permissions.canFinishVoting) {
      return;
    }
    setNoticeKey(null);
    const result = await session.dispatch({ type: 'FINISH_VOTING' });
    if (result.status === 'rejected') {
      setNoticeKey(`errors.${result.reason}`);
    }
  }

  async function listen(song: SongView) {
    if (!consented) {
      setNoticeKey('voting.consentRequired');
      return;
    }
    if (listeningId === song.videoId && previewRef.current.player !== null) {
      teardownPreview();
      setListeningId(null);
      setListenStatus('idle');
      return;
    }
    teardownPreview();
    const generation = (previewRef.current.generation += 1);
    const controller = new AbortController();
    previewRef.current.abort = controller;
    setNoticeKey(null);
    setListeningId(song.videoId);
    setListenStatus('loading');
    const host = previewRef.current.host;
    if (host === null) {
      setListeningId(null);
      setListenStatus('idle');
      return;
    }
    try {
      const player = await createPreview(host, {
        videoId: song.videoId,
        startSeconds: song.startSeconds,
        title: song.title,
        signal: controller.signal,
        onStatus: (next) => {
          if (generation !== previewRef.current.generation) {
            return;
          }
          setListenStatus(next);
        },
      });
      if (generation !== previewRef.current.generation) {
        player.destroy();
        return;
      }
      previewRef.current.player = player;
      player.play();
    } catch (error) {
      if (generation !== previewRef.current.generation) {
        return;
      }
      if (error instanceof PreviewError && error.code === 'ABORTED') {
        return;
      }
      setListenStatus({ type: 'error', code: 0 });
      setNoticeKey('voting.previewFailed');
    }
  }

  /** Card number: the song's place in the round's playback order. */
  function songNumber(song: SongView): number {
    return allSongs.findIndex((other) => other.videoId === song.videoId) + 1;
  }

  function songOwners(song: SongView) {
    if (!song.ownersVisible || song.owners.length === 0) {
      return null;
    }
    return (
      <p data-testid="voting-song-owners" className="br-read">
        {t('voting.owners', {
          names: song.owners.map((owner) => owner.nickname).join(', '),
        })}
      </p>
    );
  }

  function songButtons(song: SongView, listening: boolean) {
    const flagged = choices.flaggedVideoIds.includes(song.videoId);
    return (
      <>
        <Button
          tone="slate"
          size="sm"
          data-testid="voting-listen"
          data-video-id={song.videoId}
          data-listening={listening}
          onClick={() => {
            void listen(song);
          }}
          aria-label={t('voting.listenAria', { title: song.title })}
        >
          {listening ? t('voting.stop') : t('voting.listen')}
        </Button>
        {flaggableIds.has(song.videoId) && (
          <Button
            tone="red"
            size="sm"
            data-testid="voting-flag"
            data-video-id={song.videoId}
            pressed={flagged}
            onClick={() => {
              void toggleFlag(song);
            }}
            aria-label={t('voting.flagAria', { title: song.title })}
          >
            {t('voting.flag')}
          </Button>
        )}
      </>
    );
  }

  return (
    <Panel
      as="section"
      data-testid="voting-phase"
      data-voting-done={choices.votingDone}
      data-can-rank={permissions.canRank}
      className="br-stack"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle>{t('voting.heading')}</PanelTitle>
        <span className="br-label">{t('voting.partialHint')}</span>
      </div>
      <p className="br-read">{t('voting.intro')}</p>
      <div className="mt-3">
        <PhaseTimer
          session={session}
          state={state}
          label={t('phase.timerLabel')}
          announce={(time) => t('phase.timerAnnounce', { time })}
        />
      </div>

      <p
        data-testid="voting-announcement"
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {announcement ? t(announcement.key, announcement.values) : ''}
      </p>

      {!choices.isParticipant && (
        <p data-testid="voting-spectator" role="status" className="br-notice">
          {t('voting.spectator')}
        </p>
      )}

      {errorKey && (
        <p
          data-testid="voting-error"
          role="alert"
          className="br-notice br-notice--error"
        >
          {t(errorKey)}
        </p>
      )}

      <Panel
        well
        data-testid="voting-progress"
        data-count={doneCount}
        data-total={participants.length}
        className="br-stack"
      >
        <p className="br-read">
          {t('voting.progressHeading')}:{' '}
          {t('voting.progress', {
            done: doneCount,
            total: participants.length,
          })}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {participants.map((player) => (
            <li
              key={player.id}
              data-testid="voting-progress-player"
              data-player-id={player.id}
              data-done={player.votingDone}
              className={`br-read ${
                player.votingDone ? 'text-green' : 'text-cream-muted'
              }`}
            >
              {player.nickname}
              {player.isSelf ? ` (${t('lobby.you')})` : ''}:{' '}
              {player.votingDone
                ? t('voting.progressDone')
                : t('voting.progressOpen')}
            </li>
          ))}
        </ul>
      </Panel>

      {choices.votingDone && (
        <p data-testid="voting-done" role="status" className="br-notice">
          {t('voting.done')}
        </p>
      )}

      {choices.isParticipant && !choices.votingDone && paused && (
        <p data-testid="voting-paused" role="status" className="br-notice">
          {t('voting.paused')}
        </p>
      )}

      {choices.isParticipant &&
        !choices.votingDone &&
        !paused &&
        eligible.length === 0 && (
          <p data-testid="voting-no-songs" role="status" className="br-notice">
            {t('voting.noSongs')}
          </p>
        )}

      {choices.isParticipant && (
        <div className="grid gap-6">
          <div className="br-stack">
            <h3 className="br-label">{t('voting.rankingHeading')}</h3>
            <ol
              data-testid="voting-ranking"
              onDragOver={(event) => {
                if (editable) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOnRankingEnd();
              }}
              className="br-ranking"
            >
              {ranked.length === 0 && (
                <li className="br-notice w-full">{t('voting.emptyRanking')}</li>
              )}
              {ranked.map((song, index) => (
                <li
                  key={song.videoId}
                  data-testid="voting-rank-item"
                  data-video-id={song.videoId}
                  data-rank={index + 1}
                  draggable={editable}
                  onDragStart={(event) =>
                    onDragStart(event, 'rank', song.videoId)
                  }
                  onDragEnd={onDragEnd}
                  onDragOver={(event) => {
                    if (editable) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    dropOnRankIndex(index);
                  }}
                  className="br-panel br-panel--well br-rankrow"
                >
                  <SongCard
                    selected
                    rank={index + 1}
                    number={songNumber(song)}
                    song={song}
                    showThumbnail={consented}
                    tooltip={song.title}
                    label={t('card.faceUp', {
                      number: songNumber(song),
                      title: song.title,
                    })}
                  />
                  {songOwners(song)}
                  <div className="br-rankrow__actions">
                    <Button
                      tone="slate"
                      size="sm"
                      data-testid="voting-rank-up"
                      onClick={() => moveSong(song, -1)}
                      disabled={!editable || index === 0}
                      aria-label={t('voting.moveUpAria', {
                        title: song.title,
                        place: index,
                      })}
                    >
                      {t('voting.up')}
                    </Button>
                    <Button
                      tone="slate"
                      size="sm"
                      data-testid="voting-rank-down"
                      onClick={() => moveSong(song, 1)}
                      disabled={!editable || index === ranked.length - 1}
                      aria-label={t('voting.moveDownAria', {
                        title: song.title,
                        place: index + 2,
                      })}
                    >
                      {t('voting.down')}
                    </Button>
                    <Button
                      tone="red"
                      size="sm"
                      data-testid="voting-rank-remove"
                      onClick={() => removeSong(song)}
                      disabled={!editable}
                      aria-label={t('voting.removeAria', {
                        title: song.title,
                      })}
                    >
                      {t('voting.remove')}
                    </Button>
                    {songButtons(song, listeningId === song.videoId)}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="br-stack">
            <h3 className="br-label">{t('voting.poolHeading')}</h3>
            {editable && <p className="br-read">{t('voting.dragHint')}</p>}
            <ul
              data-testid="voting-pool"
              onDragOver={(event) => {
                if (editable) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOnPool();
              }}
              className="br-pool"
            >
              {pool.map((song, position) => (
                <li
                  key={song.videoId}
                  data-testid="voting-song"
                  data-video-id={song.videoId}
                  draggable={editable}
                  onDragStart={(event) =>
                    onDragStart(event, 'pool', song.videoId)
                  }
                  onDragEnd={onDragEnd}
                  className="br-pool__item"
                >
                  <SongCard
                    data-testid="voting-song-add"
                    index={position}
                    number={songNumber(song)}
                    song={song}
                    showThumbnail={consented}
                    onClick={() => addSong(song)}
                    disabled={!editable}
                    tooltip={song.title}
                    label={t('voting.addAria', { title: song.title })}
                  />
                  <span aria-hidden="true" className="br-label text-gold">
                    {t('voting.add')}
                  </span>
                  {songOwners(song)}
                  <div className="br-row justify-center">
                    {songButtons(song, listeningId === song.videoId)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {choices.isParticipant && (
        <div className="br-stack">
          <label className="br-check">
            <input
              type="checkbox"
              data-testid="voting-consent"
              checked={consented}
              onChange={(event) => {
                const accepted = event.target.checked;
                setConsent(accepted);
                if (!accepted) {
                  teardownPreview();
                  setListeningId(null);
                  setListenStatus('idle');
                }
              }}
              className="br-check__input"
            />
            <span>{t('voting.consentLabel')}</span>
          </label>

          <Panel well className="br-stack">
            <p
              data-testid="voting-preview-status"
              data-state={listenState}
              role="status"
              className="br-read"
            >
              {t(listenStatusKey(listenStatus))}
            </p>
            <div
              ref={(node) => {
                previewRef.current.host = node;
              }}
              data-testid="voting-preview-host"
              className="overflow-hidden rounded-md bg-black/40"
              style={{ minHeight: '1px' }}
            />
          </Panel>

          {noticeKey && (
            <p data-testid="voting-notice" role="status" className="br-notice">
              {t(noticeKey)}
            </p>
          )}

          <div>
            <Button
              data-testid="voting-finish"
              onClick={() => {
                void finishVoting();
              }}
              disabled={!permissions.canFinishVoting}
            >
              {t('voting.finish')}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
