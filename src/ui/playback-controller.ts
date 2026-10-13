import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { GameSession } from '../net/session';
import {
  createPlayback,
  type PlaybackController,
  type PlaybackDiagnostics,
  type PlaybackPlan,
} from '../player/playback';

/**
 * The room-wide playback controller handle (M4 AK-7). It is owned by RoomView
 * so the *same* player survives the SUBMISSION -> PLAYBACK phase change, and
 * consumed by PlaybackPhase, which only renders state and drives it.
 */
export interface PlaybackControllerHandle {
  diagnostics: PlaybackDiagnostics | null;
  volume: number;
  muted: boolean;
  setVolume(value: number): void;
  setMuted(value: boolean): void;
  /** Applies the current clip plan; the first call adopts a plan-less player. */
  update(plan: PlaybackPlan): void;
  recover(): void;
}

export const PlaybackControllerContext =
  createContext<PlaybackControllerHandle | null>(null);

/** Reads the room's controller handle, or `null` outside the room view. */
export function usePlaybackControllerContext(): PlaybackControllerHandle | null {
  return useContext(PlaybackControllerContext);
}

const DEFAULT_VOLUME = 70;

export interface UsePlaybackControllerOptions {
  session: GameSession;
  /** True while this tab consented and the phase is SUBMISSION or PLAYBACK. */
  active: boolean;
  title: string;
  /** The one stable host element the player is appended to, owned by RoomView. */
  hostRef: RefObject<HTMLElement | null>;
  initialVolume?: number;
  initialMuted?: boolean;
}

/**
 * Owns the one long-lived playback controller for a room tab. While `active` it
 * creates the player ahead of time (plan-less, silent) and destroys it on any
 * other phase, on consent withdrawal and on unmount. Creation is generation
 * guarded so a stale async factory result is discarded.
 */
export function usePlaybackController(
  options: UsePlaybackControllerOptions,
): PlaybackControllerHandle {
  const { session, active, title, hostRef } = options;
  const controllerRef = useRef<PlaybackController | null>(null);
  const pendingRef = useRef<{
    generation: number;
    abort: AbortController;
  } | null>(null);
  const generationRef = useRef(0);
  const planRef = useRef<PlaybackPlan | null>(null);
  const titleRef = useRef(title);
  const volumeRef = useRef(options.initialVolume ?? DEFAULT_VOLUME);
  const mutedRef = useRef(options.initialMuted ?? false);

  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostics | null>(
    null,
  );
  const [volume, setVolumeState] = useState(
    options.initialVolume ?? DEFAULT_VOLUME,
  );
  const [muted, setMutedState] = useState(options.initialMuted ?? false);
  /**
   * The latest plan key. Its change re-runs the creation effect, so a pre-warm
   * that failed can be retried when the next song's plan arrives.
   */
  const [planToken, setPlanToken] = useState<string | null>(null);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const teardown = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current?.abort.abort();
    pendingRef.current = null;
    // Drop the plan with the controller: a later activation must never replay a
    // previous round's clip before PlaybackPhase pushes the new one.
    planRef.current = null;
    const live = controllerRef.current;
    controllerRef.current = null;
    live?.destroy();
  }, []);

  // Creates the controller when the room becomes active (or when the plan
  // changes after a failed creation) and destroys it when it stops being
  // active. The plan is always null here: the pre-warm player is idle until
  // PlaybackPhase pushes the first plan via `update`. The factory emits its
  // first (loading) diagnostics synchronously, so a stale value from a previous
  // activation is always replaced.
  useEffect(() => {
    if (!active) {
      teardown();
      return;
    }
    const host = hostRef.current;
    if (
      host === null ||
      controllerRef.current !== null ||
      pendingRef.current !== null
    ) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    const abort = new AbortController();
    pendingRef.current = { generation, abort };
    void createPlayback(host, {
      plan: null,
      title: titleRef.current,
      serverNow: () => session.now(),
      onDiagnostics: (next) => {
        if (generation === generationRef.current) {
          setDiagnostics(next);
        }
      },
      signal: abort.signal,
      volume: volumeRef.current,
      muted: mutedRef.current,
    })
      .then((instance) => {
        if (generation !== generationRef.current) {
          instance.destroy();
          return;
        }
        pendingRef.current = null;
        controllerRef.current = instance;
        // A plan may have arrived while the player was loading.
        if (planRef.current !== null) {
          instance.update(planRef.current);
        }
        instance.setVolume(volumeRef.current);
        instance.setMuted(mutedRef.current);
      })
      .catch(() => {
        // The iframe API itself could not start: this client is skipped, it
        // never blocks the host timeline.
        if (generation === generationRef.current) {
          pendingRef.current = null;
          setDiagnostics({
            status: 'skipped',
            observedStartAt: null,
            startSkewMs: null,
            driftMs: null,
            currentSeconds: 0,
            expectedSeconds: 0,
            errorCode: null,
          });
        }
      });
  }, [active, session, teardown, hostRef, planToken]);

  useEffect(() => teardown, [teardown]);

  const update = useCallback((plan: PlaybackPlan) => {
    planRef.current = plan;
    if (controllerRef.current !== null) {
      controllerRef.current.update(plan);
      return;
    }
    // No live controller: a changed plan re-runs the creation effect, which
    // retries a previously failed pre-warm (the iframe API load can recover).
    // React bails out when the token is unchanged, so a failure-induced
    // re-render cannot loop the retry.
    setPlanToken((prev) => {
      const next = `${plan.videoId}|${plan.startSeconds}|${plan.clipSeconds}|${plan.startAt}|${plan.deadlineAt}|${plan.pausedAt}`;
      return prev === next ? prev : next;
    });
  }, []);

  const recover = useCallback(() => {
    controllerRef.current?.recover();
  }, []);

  const setVolume = useCallback((value: number) => {
    volumeRef.current = value;
    setVolumeState(value);
    controllerRef.current?.setVolume(value);
  }, []);

  const setMuted = useCallback((value: boolean) => {
    mutedRef.current = value;
    setMutedState(value);
    controllerRef.current?.setMuted(value);
  }, []);

  return useMemo(
    () => ({
      diagnostics,
      volume,
      muted,
      setVolume,
      setMuted,
      update,
      recover,
    }),
    [diagnostics, volume, muted, setVolume, setMuted, update, recover],
  );
}
