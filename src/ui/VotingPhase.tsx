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

  function songOwners(song: SongView) {
    if (!song.ownersVisible || song.owners.length === 0) {
      return null;
    }
    return (
      <p
        data-testid="voting-song-owners"
        className="mt-1 text-xs text-cream-100/60"
      >
        {t('voting.owners', {
          names: song.owners.map((owner) => owner.nickname).join(', '),
        })}
      </p>
    );
  }

  function songButtons(song: SongView, listening: boolean) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="voting-listen"
          data-video-id={song.videoId}
          data-listening={listening}
          onClick={() => {
            void listen(song);
          }}
          aria-label={t('voting.listenAria', { title: song.title })}
          className="rounded-md border border-gold-400/40 px-2 py-1 text-xs text-cream-100 transition hover:bg-gold-500/15"
        >
          {listening ? t('voting.stop') : t('voting.listen')}
        </button>
        {flaggableIds.has(song.videoId) && (
          <button
            type="button"
            data-testid="voting-flag"
            data-video-id={song.videoId}
            aria-pressed={choices.flaggedVideoIds.includes(song.videoId)}
            onClick={() => {
              void toggleFlag(song);
            }}
            aria-label={t('voting.flagAria', { title: song.title })}
            className={`rounded-md border px-2 py-1 text-xs transition ${
              choices.flaggedVideoIds.includes(song.videoId)
                ? 'border-rose-400/60 bg-rose-500/20 text-rose-100'
                : 'border-rose-400/40 text-rose-200 hover:bg-rose-500/15'
            }`}
          >
            {t('voting.flag')}
          </button>
        )}
      </div>
    );
  }

  return (
    <section
      data-testid="voting-phase"
      data-voting-done={choices.votingDone}
      data-can-rank={permissions.canRank}
      className="rounded-xl border border-gold-400/25 bg-felt-800/50 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-gold-300">
          {t('voting.heading')}
        </h2>
        <span className="text-xs text-cream-100/60">
          {t('voting.partialHint')}
        </span>
      </div>
      <p className="mt-1 text-sm text-cream-100/70">{t('voting.intro')}</p>

      <p
        data-testid="voting-announcement"
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {announcement ? t(announcement.key, announcement.values) : ''}
      </p>

      {!choices.isParticipant && (
        <p
          data-testid="voting-spectator"
          role="status"
          className="mt-3 rounded-lg border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100"
        >
          {t('voting.spectator')}
        </p>
      )}

      {errorKey && (
        <p
          data-testid="voting-error"
          role="alert"
          className="mt-3 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
        >
          {t(errorKey)}
        </p>
      )}

      <div
        data-testid="voting-progress"
        data-count={doneCount}
        data-total={participants.length}
        className="mt-4 rounded-lg border border-gold-400/20 bg-felt-900/50 px-3 py-2"
      >
        <p className="text-sm text-cream-100/80">
          {t('voting.progressHeading')}:{' '}
          {t('voting.progress', {
            done: doneCount,
            total: participants.length,
          })}
        </p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {participants.map((player) => (
            <li
              key={player.id}
              data-testid="voting-progress-player"
              data-player-id={player.id}
              data-done={player.votingDone}
              className={
                player.votingDone ? 'text-emerald-200' : 'text-cream-100/60'
              }
            >
              {player.nickname}
              {player.isSelf ? ` (${t('lobby.you')})` : ''}:{' '}
              {player.votingDone
                ? t('voting.progressDone')
                : t('voting.progressOpen')}
            </li>
          ))}
        </ul>
      </div>

      {choices.votingDone && (
        <p
          data-testid="voting-done"
          role="status"
          className="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100"
        >
          {t('voting.done')}
        </p>
      )}

      {choices.isParticipant && !choices.votingDone && paused && (
        <p
          data-testid="voting-paused"
          role="status"
          className="mt-4 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          {t('voting.paused')}
        </p>
      )}

      {choices.isParticipant &&
        !choices.votingDone &&
        !paused &&
        eligible.length === 0 && (
          <p
            data-testid="voting-no-songs"
            role="status"
            className="mt-4 rounded-lg border border-gold-400/25 bg-felt-900/60 px-3 py-2 text-sm text-cream-100/80"
          >
            {t('voting.noSongs')}
          </p>
        )}

      {choices.isParticipant && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-gold-200">
              {t('voting.rankingHeading')}
            </h3>
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
              className="mt-2 space-y-2"
            >
              {ranked.length === 0 && (
                <li className="rounded-lg border border-dashed border-gold-400/25 px-3 py-2 text-xs text-cream-100/60">
                  {t('voting.emptyRanking')}
                </li>
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
                  className="rounded-lg border border-gold-400/25 bg-felt-900/60 p-2"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-1 font-display text-lg text-gold-200">
                      {index + 1}.
                    </span>
                    {consented && (
                      <img
                        src={song.thumbnail}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-12 w-20 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-cream-100">
                        {song.title}
                      </p>
                      <p className="truncate text-xs text-cream-100/60">
                        {song.channel}
                      </p>
                      {songOwners(song)}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="voting-rank-up"
                      onClick={() => moveSong(song, -1)}
                      disabled={!editable || index === 0}
                      aria-label={t('voting.moveUpAria', {
                        title: song.title,
                        place: index,
                      })}
                      className="rounded-md border border-gold-400/40 px-2 py-1 text-xs text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('voting.up')}
                    </button>
                    <button
                      type="button"
                      data-testid="voting-rank-down"
                      onClick={() => moveSong(song, 1)}
                      disabled={!editable || index === ranked.length - 1}
                      aria-label={t('voting.moveDownAria', {
                        title: song.title,
                        place: index + 2,
                      })}
                      className="rounded-md border border-gold-400/40 px-2 py-1 text-xs text-cream-100 transition hover:bg-gold-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('voting.down')}
                    </button>
                    <button
                      type="button"
                      data-testid="voting-rank-remove"
                      onClick={() => removeSong(song)}
                      disabled={!editable}
                      aria-label={t('voting.removeAria', { title: song.title })}
                      className="rounded-md border border-rose-400/40 px-2 py-1 text-xs text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('voting.remove')}
                    </button>
                    {songButtons(song, listeningId === song.videoId)}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gold-200">
              {t('voting.poolHeading')}
            </h3>
            {editable && (
              <p className="mt-1 text-xs text-cream-100/50">
                {t('voting.dragHint')}
              </p>
            )}
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
              className="mt-2 space-y-2"
            >
              {pool.map((song) => (
                <li
                  key={song.videoId}
                  data-testid="voting-song"
                  data-video-id={song.videoId}
                  draggable={editable}
                  onDragStart={(event) =>
                    onDragStart(event, 'pool', song.videoId)
                  }
                  onDragEnd={onDragEnd}
                  className="rounded-lg border border-gold-400/20 bg-felt-900/50 p-2"
                >
                  <button
                    type="button"
                    data-testid="voting-song-add"
                    onClick={() => addSong(song)}
                    disabled={!editable}
                    aria-label={t('voting.addAria', { title: song.title })}
                    className="flex w-full items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {consented && (
                      <img
                        src={song.thumbnail}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-12 w-20 rounded object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-cream-100">
                        {song.title}
                      </span>
                      <span className="block truncate text-xs text-cream-100/60">
                        {song.channel}
                      </span>
                    </span>
                    <span className="text-xs text-gold-200">
                      {t('voting.add')}
                    </span>
                  </button>
                  {songOwners(song)}
                  <div className="mt-2">
                    {songButtons(song, listeningId === song.videoId)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {choices.isParticipant && (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-sm text-cream-100/80">
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
              className="mt-1"
            />
            <span>{t('voting.consentLabel')}</span>
          </label>

          <div className="rounded-lg border border-gold-400/20 bg-felt-900/50 p-2">
            <p
              data-testid="voting-preview-status"
              data-state={listenState}
              role="status"
              className="text-xs text-cream-100/70"
            >
              {t(listenStatusKey(listenStatus))}
            </p>
            <div
              ref={(node) => {
                previewRef.current.host = node;
              }}
              data-testid="voting-preview-host"
              className="mt-2 overflow-hidden rounded-md border border-gold-400/20 bg-black/40"
              style={{ minHeight: '1px' }}
            />
          </div>

          {noticeKey && (
            <p
              data-testid="voting-notice"
              role="status"
              className="rounded-lg border border-gold-400/25 bg-felt-900/60 px-3 py-2 text-xs text-cream-100/80"
            >
              {t(noticeKey)}
            </p>
          )}

          <button
            type="button"
            data-testid="voting-finish"
            onClick={() => {
              void finishVoting();
            }}
            disabled={!permissions.canFinishVoting}
            className="rounded-md border border-emerald-400/50 bg-emerald-500/20 px-4 py-2 text-sm text-cream-100 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('voting.finish')}
          </button>
        </div>
      )}
    </section>
  );
}
