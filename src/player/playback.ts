import { VideoId } from '../shared/primitives';
import { parseYouTubeLink } from './links';
import {
  awaitWithAbort,
  createYouTubeIframe,
  loadIframeApi,
  PreviewError,
} from './iframe';
import type { YouTubeApi, YouTubeEvent, YouTubePlayer } from './iframe';

/**
 * Absolute, server-normalized playback plan for a single song (FR-30, FR-31).
 * All timestamps are milliseconds in the shared server timeline, never local
 * wall-clock. `pausedAt` freezes the elapsed position while a round is paused.
 */
export interface PlaybackPlan {
  videoId: string;
  startSeconds: number;
  clipSeconds: number;
  startAt: number;
  deadlineAt: number;
  pausedAt: number | null;
}

export type PlaybackStatus =
  | 'loading'
  | 'cued'
  | 'scheduled'
  | 'playing'
  | 'buffering'
  | 'blocked'
  | 'paused'
  | 'skipped'
  | 'ended';

/**
 * Diagnostics for the `?debug=1` overlay (AK-7). `observedStartAt` is captured
 * from the first *audible* PLAYING event (at or after `startAt`), never from a
 * muted prebuffer play or from issuing `playVideo`, so it is the only honest
 * evidence that audio started.
 */
export interface PlaybackDiagnostics {
  status: PlaybackStatus;
  observedStartAt: number | null;
  startSkewMs: number | null;
  driftMs: number | null;
  currentSeconds: number;
  expectedSeconds: number;
  errorCode: number | null;
}

export interface PlaybackController {
  update(plan: PlaybackPlan): void;
  recover(): void;
  setVolume(value: number): void;
  setMuted(value: boolean): void;
  destroy(): void;
}

/** Injectable timer seam so tests drive scheduling deterministically. */
export interface PlaybackScheduler {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface PlaybackOptions {
  /**
   * The clip to play, or `null` to create the player ahead of time (M4 AK-7
   * pre-warm). A plan-less controller loads the API and constructs the YT
   * player (id-less embed, no autoplay) but stays idle: no cue, no play. The
   * first {@link PlaybackController.update} cues the clip and runs the ordinary
   * CUED-gated schedule.
   */
  plan: PlaybackPlan | null;
  title: string;
  serverNow: () => number;
  onDiagnostics: (value: PlaybackDiagnostics) => void;
  signal?: AbortSignal;
  volume?: number;
  muted?: boolean;
  scheduler?: PlaybackScheduler;
}

const PLAYER_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;
/** FR-32: only correct drift above 750 ms, targeting the ±500 ms window. */
const DRIFT_THRESHOLD_MS = 750;
/** After a correction YouTube re-buffers; do not seek again within this window. */
const SEEK_COOLDOWN_MS = 1_000;
/**
 * M4 AK-7: the preroll warms the stream with a *muted* pre-start play. Below
 * this remaining lead there is no time to pause, rewind and resume, so the
 * client skips the prebuffer and starts directly at `startAt`.
 */
const PREBUFFER_MIN_LEAD_MS = 300;
/**
 * M4 AK-7 (start accuracy): the real start `playVideo` is issued this fixed
 * amount before `startAt` while audio stays suppressed, so the media is already
 * running when the audio is restored.
 */
const START_LEAD_MS = 250;
/**
 * M4 AK-7 (start accuracy): if the prebuffer's own PLAYING arrives this close to
 * `startAt`, there is no time to pause and resume: keep it running muted and
 * just unmute at `startAt`.
 */
const KEEP_RUNNING_MS = 500;

const STATE_ENDED = 0;
const STATE_PLAYING = 1;
const STATE_PAUSED = 2;
const STATE_BUFFERING = 3;
const STATE_CUED = 5;

const defaultScheduler: PlaybackScheduler = {
  setTimeout: (handler, ms) =>
    globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function isValidPlan(plan: PlaybackPlan): boolean {
  return (
    VideoId.safeParse(plan.videoId).success &&
    Number.isFinite(plan.startSeconds) &&
    plan.startSeconds >= 0 &&
    Number.isFinite(plan.clipSeconds) &&
    plan.clipSeconds > 0 &&
    Number.isFinite(plan.startAt) &&
    Number.isFinite(plan.deadlineAt) &&
    plan.deadlineAt >= plan.startAt &&
    (plan.pausedAt === null || Number.isFinite(plan.pausedAt))
  );
}

function planKey(plan: PlaybackPlan): string {
  return [
    plan.videoId,
    plan.startSeconds,
    plan.clipSeconds,
    plan.startAt,
    plan.deadlineAt,
    plan.pausedAt,
  ].join('|');
}

class PlaybackSession implements PlaybackController {
  private destroyed = false;
  /**
   * Bumped on every plan change and on destroy. Every timer and event callback
   * captures the generation it was armed under and bails when it moved on.
   */
  private generation = 0;
  private player: YouTubePlayer | null = null;
  private iframe: HTMLIFrameElement | null = null;
  /** `null` until the first plan arrives; see {@link PlaybackOptions.plan}. */
  private plan: PlaybackPlan | null;
  private lastKey: string | null;
  /**
   * The video we just left. Events and identity checks that still report it
   * are stale leftovers of the previous song and are ignored, so they can
   * neither end nor seek the new song.
   */
  private previousVideoId: string | null = null;
  /** True once YouTube reported CUED(5); API-ready alone is not cue-ready. */
  private cueReady = false;
  /**
   * The iframe loads its URL video and may report states before our clip cue.
   * Those states predate the clip bounds and must never start playback.
   */
  private cueIssued = false;
  /** True once playVideo was issued for the current clip, so it starts once. */
  private startRequested = false;
  /**
   * M4 AK-7: the muted pre-start warm-up is engaged for the current clip, from
   * the prebuffer play until the real start. Its re-emitted CUED must not
   * restart it, and it must not be re-engaged twice.
   */
  private prebufferEngaged = false;
  /**
   * M4 AK-7: a muted pre-start play is in flight (issued, PLAYING not yet seen).
   * Only the controller's own PLAYING may complete it; a late/stale one may not.
   */
  private prebufferPlayIssued = false;
  /** True once the real start playVideo (at `startAt - START_LEAD_MS`) was issued. */
  private startPlayIssued = false;
  /**
   * True while the muted media is confirmed PLAYING before `startAt` and only
   * the unmute is left. Cleared by a stall (BUFFERING/PAUSED) so the timer can
   * never claim a silent start from a media that stopped.
   */
  private prebufferRunning = false;
  /**
   * While true the player is forced silent (muted, volume 0) so nothing is
   * audible before `startAt`, no matter what the user does with volume/mute.
   */
  private audioSuppressed = false;
  private status: PlaybackStatus = 'loading';
  private observedStartAt: number | null = null;
  private startSkewMs: number | null = null;
  private driftMs: number | null = null;
  private currentSecondsValue = 0;
  private expectedSecondsValue = 0;
  private errorCode: number | null = null;
  private volume: number;
  private muted: boolean;
  private startTimer: number | null = null;
  private startLeadTimer: number | null = null;
  private pollTimer: number | null = null;
  private deadlineTimer: number | null = null;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: PreviewError) => void) | null = null;
  private readonly scheduler: PlaybackScheduler;
  private readonly abortListener = () => this.destroy();

  constructor(
    private readonly container: HTMLElement,
    private readonly options: PlaybackOptions,
  ) {
    this.plan = options.plan;
    this.lastKey = options.plan === null ? null : planKey(options.plan);
    this.volume = clampVolume(options.volume ?? 100);
    this.muted = options.muted ?? false;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  async start(): Promise<void> {
    if (!this.container || (this.plan !== null && !isValidPlan(this.plan))) {
      throw new PreviewError('INVALID_OPTIONS', 'Invalid playback options');
    }
    if (this.options.signal?.aborted === true) {
      throw new PreviewError('ABORTED', 'Playback aborted before start');
    }
    this.options.signal?.addEventListener('abort', this.abortListener, {
      once: true,
    });
    this.setStatus('loading');

    let api: YouTubeApi;
    try {
      api = await awaitWithAbort(loadIframeApi(), this.options.signal);
    } catch (error) {
      this.destroy();
      throw error;
    }
    if (this.destroyed) {
      throw new PreviewError(
        'ABORTED',
        'Playback aborted while loading the API',
      );
    }

    const iframe = createYouTubeIframe(
      this.plan?.videoId ?? null,
      this.options.title,
    );
    // Marker for the e2e fixture: distinguishes the one long-lived playback
    // player from the transient submission preview players.
    iframe.dataset.playbackPlayer = 'true';
    iframe.tabIndex = -1;
    this.iframe = iframe;
    this.container.append(iframe);
    const ready = this.createReadyGate();
    // A synchronous construction failure below never awaits `ready`; keep the
    // gate's rejection handled so it cannot surface as an unhandled rejection.
    void ready.catch(() => undefined);
    try {
      this.player = new api.Player(iframe, {
        events: {
          onReady: () => this.releaseReady(),
          onStateChange: (event) => this.handleStateChange(event),
          onError: (event) => this.handleError(event),
          onAutoplayBlocked: () => this.handleAutoplayBlocked(),
        },
      });
      await ready;
    } catch (error) {
      this.destroy();
      throw error;
    }
    // An embedding error released the gate above; the song is skipped locally
    // and the round continues (FR-33), so never cue or play it.
    if (this.errorCode !== null) {
      return;
    }
    this.handleReady();
  }

  update(plan: PlaybackPlan): void {
    if (this.destroyed || !isValidPlan(plan)) {
      return;
    }
    const key = planKey(plan);
    if (key === this.lastKey) {
      return;
    }
    if (this.plan === null) {
      // First plan after a plan-less pre-warm creation (M4 AK-7): adopt it, cue
      // the clip and run the ordinary CUED-gated schedule, prebuffer included.
      this.adoptFirstPlan(plan, key);
      return;
    }
    const videoChanged = plan.videoId !== this.plan.videoId;
    const clipChanged =
      videoChanged ||
      plan.startSeconds !== this.plan.startSeconds ||
      plan.clipSeconds !== this.plan.clipSeconds;
    if (
      !clipChanged &&
      (this.status === 'skipped' || this.status === 'ended')
    ) {
      // A local skip/end is terminal for this clip: a same-clip timestamp
      // change (host pause/resume) must not resurrect the song.
      this.plan = plan;
      this.lastKey = key;
      this.generation += 1;
      this.clearTimers();
      return;
    }
    const oldVideoId = this.plan.videoId;
    this.plan = plan;
    this.lastKey = key;
    this.generation += 1;
    this.clearTimers();
    this.startRequested = false;
    if (clipChanged) {
      if (videoChanged) {
        this.previousVideoId = oldVideoId;
      }
      // New clip (different video or changed bounds): drop all prior evidence
      // and re-cue so the bounds actually reach the player. Any prebuffer from
      // the previous clip must not leak its muted state into the next song.
      this.status = 'loading';
      this.observedStartAt = null;
      this.startSkewMs = null;
      this.driftMs = null;
      this.errorCode = null;
      this.lastSeekAt = Number.NEGATIVE_INFINITY;
      this.cancelPrebuffer();
      if (this.audioSuppressed) {
        // The previous clip's muted pre-start play may still be running. Stop
        // the media *before* the cue replaces it, and stay suppressed until the
        // new clip's own real start (it is still pre-start), so an in-flight
        // prebuffer can never leak audible while the old clip is unmuted.
        this.pause();
      } else {
        this.applyAudio();
      }
      if (this.player !== null) {
        this.cue();
      }
    }
    if (plan.pausedAt !== null) {
      // A paused round freezes the timeline: no start and, crucially, no
      // deadline timer, so a long host pause cannot end the song underway. A
      // running prebuffer is cancelled but the player stays silent until the
      // shifted start, where audio is restored for real.
      this.clearTimers();
      this.cancelPrebuffer();
      this.pause();
      this.setStatus('paused');
      this.armPoll(this.generation);
      return;
    }
    if (this.player === null) {
      // Still loading; the ready handler schedules against the latest plan.
      return;
    }
    this.armSchedule();
  }

  /**
   * M4 AK-7: adopts the first plan of a plan-less pre-warm creation. Mirrors
   * the clip-change reset and then runs the ordinary CUED-gated schedule, so
   * the prebuffer and every existing guard behave exactly as on a re-cue.
   */
  private adoptFirstPlan(plan: PlaybackPlan, key: string): void {
    this.plan = plan;
    this.lastKey = key;
    this.generation += 1;
    this.clearTimers();
    this.startRequested = false;
    this.status = 'loading';
    this.observedStartAt = null;
    this.startSkewMs = null;
    this.driftMs = null;
    this.errorCode = null;
    this.lastSeekAt = Number.NEGATIVE_INFINITY;
    this.cancelPrebuffer();
    this.audioSuppressed = false;
    this.applyAudio();
    if (this.player !== null) {
      this.cue();
    }
    if (plan.pausedAt !== null) {
      this.clearTimers();
      this.cancelPrebuffer();
      this.pause();
      this.setStatus('paused');
      this.armPoll(this.generation);
      return;
    }
    if (this.player === null) {
      // Still loading; the ready handler schedules against this plan.
      return;
    }
    this.armSchedule();
  }

  recover(): void {
    if (this.destroyed || this.plan === null || this.plan.pausedAt !== null) {
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    const now = this.options.serverNow();
    if (now >= this.plan.deadlineAt) {
      return;
    }
    // Autoplay was blocked; only a direct user gesture can start playback.
    // Never play before the agreed start, and never claim it as started here.
    if (now < this.plan.startAt) {
      this.armSchedule();
      return;
    }
    if (!this.cueReady) {
      return;
    }
    this.startRequested = true;
    this.setStatus('scheduled');
    try {
      this.player?.playVideo();
    } catch {
      // A destroyed player throws; the next diagnostics still report blocked.
    }
  }

  setVolume(value: number): void {
    if (this.destroyed) {
      return;
    }
    this.volume = clampVolume(value);
    this.applyAudio();
  }

  setMuted(value: boolean): void {
    if (this.destroyed) {
      return;
    }
    this.muted = value;
    this.applyAudio();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.generation += 1;
    this.clearTimers();
    this.options.signal?.removeEventListener('abort', this.abortListener);
    this.releaseReady(new PreviewError('ABORTED', 'Playback destroyed'));
    try {
      this.player?.destroy();
    } catch {
      // The player may already be gone; removing the node below still applies.
    }
    if (this.iframe?.isConnected === true) {
      this.iframe.remove();
    }
    this.player = null;
    this.iframe = null;
  }

  /** Cue only; `loadVideoById`/`playVideo` are deliberately never used here. */
  private cue(): void {
    if (this.player === null || this.plan === null) {
      return;
    }
    // A fresh cue invalidates readiness; only a new CUED event restores it.
    this.cueIssued = true;
    this.cueReady = false;
    const { videoId, startSeconds, clipSeconds } = this.plan;
    try {
      this.player.cueVideoById({
        videoId,
        startSeconds,
        endSeconds: startSeconds + clipSeconds,
      });
    } catch {
      // A destroyed player throws; scheduling below still runs.
    }
  }

  private pause(): void {
    try {
      this.player?.pauseVideo();
    } catch {
      // A destroyed player throws; the status below is still truthful.
    }
  }

  private handleReady(): void {
    if (this.destroyed) {
      return;
    }
    this.applyAudio();
    if (this.plan === null) {
      // M4 AK-7 pre-warm: the player is ready but idle until the first plan.
      return;
    }
    this.cue();
    if (this.status === 'loading') {
      this.setStatus('cued');
    }
    this.armSchedule();
  }

  private handleStateChange(event: YouTubeEvent): void {
    if (this.destroyed || !this.cueIssued || this.isStaleEvent()) {
      return;
    }
    // A locally skipped or finished song is terminal: stray state events must
    // not revive it. Only a real PLAYING is still dispatched, so physical
    // media that is somehow running is stopped again without touching status
    // or start evidence.
    if (this.status === 'skipped' || this.status === 'ended') {
      if (event.data === STATE_PLAYING) {
        this.handlePlaying();
      }
      return;
    }
    switch (event.data) {
      case STATE_PLAYING:
        this.handlePlaying();
        break;
      case STATE_BUFFERING:
        // The muted prebuffer and its rewind seek emit BUFFERING/PAUSED of
        // their own; those are not audible states and must never repaint the
        // scheduled status before the real start.
        if (this.audioSuppressed) {
          // A stall means the media is no longer confirmed playing, so the
          // start timer must not claim a silent start from it.
          this.prebufferRunning = false;
          break;
        }
        if (
          this.status === 'playing' ||
          this.status === 'buffering' ||
          this.status === 'scheduled'
        ) {
          this.setStatus('buffering');
        }
        break;
      case STATE_PAUSED:
        if (this.audioSuppressed) {
          this.prebufferRunning = false;
          break;
        }
        if (this.status !== 'paused') {
          this.setStatus('paused');
        }
        break;
      case STATE_ENDED:
        // A late ENDED from the *previous* clip can arrive after the next cue,
        // already reporting the new video id, so `isStaleEvent` misses it. Only
        // end a clip that actually started (a pre-start ENDED is meaningless).
        if (this.observedStartAt !== null) {
          this.handleDeadline(this.generation);
        }
        break;
      case STATE_CUED:
        this.cueReady = true;
        if (this.prebufferEngaged) {
          // The warm-up's own play/rewind can re-emit CUED; keep the scheduled
          // status and do not restart it. A CUED for a *new* clip (a clip change
          // during an in-flight warm-up) has already cleared the flag, so it
          // falls through and warms that clip too.
          break;
        }
        if (this.status === 'loading') {
          this.setStatus('cued');
        }
        // A cue that lands after startAt (or after a late ready) still starts
        // the clip, as long as the window is open and the round is not paused.
        this.maybePrebuffer(this.generation);
        this.attemptStart(this.generation);
        break;
      default:
        break;
    }
  }

  private handlePlaying(): void {
    if (this.plan === null) {
      return;
    }
    // Terminal first: stop any physical playback without touching status,
    // error code or start evidence.
    if (this.status === 'skipped' || this.status === 'ended') {
      this.pause();
      return;
    }
    const current = this.currentVideoId();
    if (current !== null && current !== this.plan.videoId) {
      // A different video navigated in the shared player: never seek into it.
      this.skip(0);
      return;
    }
    const now = this.options.serverNow();
    // Only a host pause (authoritative pausedAt) blocks playback. A 'paused'
    // status without plan.pausedAt is a local/native pause: a PLAYING means
    // the media resumed, so recover the scheduled timeline and catch up.
    if (this.plan.pausedAt !== null) {
      this.pause();
      if (this.status !== 'paused') {
        this.setStatus('paused');
      }
      return;
    }
    if (now >= this.plan.deadlineAt) {
      this.handleDeadline(this.generation);
      return;
    }
    if (now < this.plan.startAt) {
      if (this.prebufferPlayIssued) {
        this.prebufferPlayIssued = false;
        if (this.plan.startAt - now <= KEEP_RUNNING_MS) {
          // Too little lead left to pause and resume: keep the muted media
          // running and just unmute at `startAt`.
          this.prebufferRunning = true;
          return;
        }
        // Pause and rewind to the clip start; the real start play is issued
        // `START_LEAD_MS` before `startAt`, still muted.
        this.pause();
        try {
          this.player?.seekTo(this.plan.startSeconds, true);
        } catch {
          // A destroyed player throws; the deadline still ends the clip.
        }
        this.armStartLead(this.generation);
        return;
      }
      if (this.startPlayIssued || this.prebufferRunning) {
        // Our own muted media is (re)playing before startAt: keep it running,
        // never pause and never claim. The `startAt` timer unmutes and claims.
        this.prebufferRunning = true;
        return;
      }
      // Native controls may start early; stop them and retain the scheduled
      // start instead of losing the only PLAYING event for the whole clip.
      this.pause();
      return;
    }
    if (this.audioSuppressed) {
      // startAt arrived while the muted media was already running (or its
      // PLAYING only now landed): restore audio and treat this as the real
      // start. Drift correction absorbs any offset; never pause it here.
      this.restoreAudio();
      // The media is already the real, running start. Claim the start so the
      // still-armed `attemptStart` cannot issue a second playVideo or repaint
      // the status back to 'scheduled'.
      this.startRequested = true;
      if (this.startTimer !== null) {
        this.scheduler.clearTimeout(this.startTimer);
        this.startTimer = null;
      }
    }
    this.claimStart(now, false);
  }

  /**
   * Claims the audible start; never before `startAt`. `contentAligned` marks a
   * claim from the aligned pre-roll at `startAt`, where the honest skew is the
   * content offset (negative = content ahead) rather than how late it started.
   */
  private claimStart(now: number, contentAligned: boolean): void {
    if (this.plan === null) {
      return;
    }
    const firstClaim = this.observedStartAt === null;
    if (firstClaim) {
      this.observedStartAt = now;
      this.startSkewMs = now - this.plan.startAt;
    }
    this.status = 'playing';
    this.refresh();
    if (firstClaim && contentAligned) {
      this.startSkewMs =
        (this.expectedSecondsValue - this.currentSecondsValue) * 1000;
    }
    this.emit();
    // Catch up after a late cue, buffering or ad pause once audio is real.
    this.correctDrift(now);
  }

  private handleError(event: YouTubeEvent): void {
    if (this.destroyed || this.isStaleEvent()) {
      return;
    }
    if (this.plan === null) {
      // No clip to skip yet: release the ready gate so a plan-less creation
      // still resolves instead of blocking on the timeout.
      this.releaseReady();
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    // Release a pending ready gate so creation still resolves with a skipped
    // song instead of blocking the round on the timeout.
    this.releaseReady();
    this.skip(event.data ?? 0);
  }

  private handleAutoplayBlocked(): void {
    if (this.destroyed || this.isStaleEvent()) {
      return;
    }
    if (this.plan === null) {
      // Nothing to play yet; a plan-less player cannot be a real block.
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    if (this.audioSuppressed) {
      // A blocked *muted* pre-start play is not a real playback block: abandon
      // the prebuffer quietly and let the ordinary start at `startAt` report a
      // block on its own if the unmuted attempt is blocked too.
      this.abandonPrebuffer();
      return;
    }
    this.setStatus('blocked');
  }

  private handleDeadline(gen: number): void {
    if (this.destroyed || gen !== this.generation) {
      return;
    }
    // Seeking invalidates YouTube's `endSeconds`, so the clip end is enforced
    // by this independent absolute deadline and the poll below.
    this.clearTimers();
    this.startRequested = false;
    this.pause();
    this.setStatus('ended');
  }

  private skip(code: number): void {
    this.clearTimers();
    this.startRequested = false;
    this.errorCode = code;
    this.pause();
    this.setStatus('skipped');
  }

  private armSchedule(): void {
    this.clearTimers();
    if (this.plan === null) {
      return;
    }
    // A cue-time error can mark the clip skipped before this runs; never
    // reschedule over a terminal state.
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    if (this.plan.pausedAt !== null) {
      this.setStatus('paused');
      return;
    }
    const now = this.options.serverNow();
    if (now >= this.plan.deadlineAt) {
      this.handleDeadline(this.generation);
      return;
    }
    const gen = this.generation;
    this.armDeadline(gen);
    if (now < this.plan.startAt) {
      this.setStatus('scheduled');
      this.maybePrebuffer(gen);
      this.startTimer = this.scheduler.setTimeout(
        () => this.attemptStart(gen),
        this.plan.startAt - now,
      );
    } else {
      this.attemptStart(gen);
    }
    this.armPoll(gen);
  }

  private attemptStart(gen: number): void {
    if (this.destroyed || gen !== this.generation || this.plan === null) {
      return;
    }
    this.startTimer = null;
    if (this.plan.pausedAt !== null) {
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    const now = this.options.serverNow();
    if (now >= this.plan.deadlineAt) {
      this.handleDeadline(gen);
      return;
    }
    if (now < this.plan.startAt) {
      this.startTimer = this.scheduler.setTimeout(
        () => this.attemptStart(gen),
        this.plan.startAt - now,
      );
      return;
    }
    // API-ready is not cue-ready: wait for the CUED event before starting, so
    // a playVideo issued while the cue is still loading is not silently lost.
    if (!this.cueReady) {
      return;
    }
    if (this.startRequested) {
      return;
    }
    // Start is only ever requested at or after the absolute start time.
    this.startRequested = true;
    if (this.audioSuppressed) {
      // The muted media is already running (or the real start play is in
      // flight): the unmute below is the audible start. Only media confirmed
      // PLAYING is claimed here, with the honest content offset; otherwise the
      // real PLAYING claims later.
      this.restoreAudio();
      if (this.prebufferRunning) {
        this.claimStart(now, true);
        return;
      }
      if (this.prebufferPlayIssued || this.startPlayIssued) {
        // A muted play is still in flight; its PLAYING is the honest start.
        // A second, now audible playVideo would be redundant.
        return;
      }
      // Nothing muted is running: a host pause or clip change cancelled the
      // prebuffer and the (shifted) start is already due. Start audibly.
    }
    // No pre-start muted media of ours: start audibly now.
    this.cancelPrebuffer();
    this.restoreAudio();
    this.setStatus('scheduled');
    try {
      this.player?.playVideo();
    } catch {
      // A destroyed player throws; diagnostics continue to report honestly.
    }
  }

  private armDeadline(gen: number): void {
    if (this.plan === null) {
      return;
    }
    const delay = Math.max(0, this.plan.deadlineAt - this.options.serverNow());
    this.deadlineTimer = this.scheduler.setTimeout(
      () => this.handleDeadline(gen),
      delay,
    );
  }

  private armPoll(gen: number): void {
    this.pollTimer = this.scheduler.setTimeout(
      () => this.tick(gen),
      POLL_INTERVAL_MS,
    );
  }

  private tick(gen: number): void {
    if (this.destroyed || gen !== this.generation || this.plan === null) {
      return;
    }
    this.pollTimer = null;
    if (this.status === 'skipped') {
      return;
    }
    const now = this.options.serverNow();
    if (
      this.plan.pausedAt === null &&
      now >= this.plan.deadlineAt &&
      this.status !== 'ended'
    ) {
      this.handleDeadline(gen);
      return;
    }
    this.refresh();
    this.emit();
    if (this.status === 'playing') {
      this.correctDrift(now);
    }
    this.armPoll(gen);
  }

  private correctDrift(now: number): void {
    if (
      this.plan === null ||
      this.observedStartAt === null ||
      this.driftMs === null
    ) {
      return;
    }
    // Never correct outside the active, unpaused, non-terminal interval: a
    // seek there could restart a paused or already finished clip.
    if (this.status !== 'playing' || this.plan.pausedAt !== null) {
      return;
    }
    if (now < this.plan.startAt || now >= this.plan.deadlineAt) {
      return;
    }
    if (Math.abs(this.driftMs) <= DRIFT_THRESHOLD_MS) {
      return;
    }
    if (now - this.lastSeekAt < SEEK_COOLDOWN_MS) {
      return;
    }
    const current = this.currentVideoId();
    if (current !== null && current !== this.plan.videoId) {
      this.skip(0);
      return;
    }
    this.lastSeekAt = now;
    try {
      this.player?.seekTo(this.expectedSecondsValue, true);
    } catch {
      // A destroyed player throws; the next tick recomputes the drift.
    }
  }

  private refresh(): void {
    if (this.plan === null) {
      // Plan-less pre-warm: nothing scheduled, so nothing to compare against.
      this.expectedSecondsValue = 0;
      this.currentSecondsValue = this.readCurrentTime();
      this.driftMs = null;
      return;
    }
    const now = this.options.serverNow();
    this.expectedSecondsValue = this.expectedSeconds(now);
    this.currentSecondsValue = this.readCurrentTime();
    this.driftMs =
      this.observedStartAt === null
        ? null
        : (this.currentSecondsValue - this.expectedSecondsValue) * 1000;
  }

  /**
   * Expected position derived purely from the absolute timeline. While paused
   * the elapsed time is frozen at `pausedAt`; a resume arrives as a shifted
   * `startAt`/`deadlineAt` so the position stays continuous.
   */
  private expectedSeconds(now: number): number {
    if (this.plan === null) {
      return 0;
    }
    const { startSeconds, clipSeconds, startAt, pausedAt } = this.plan;
    const elapsed = ((pausedAt ?? now) - startAt) / 1000;
    const clamped = Math.min(Math.max(elapsed, 0), clipSeconds);
    return startSeconds + clamped;
  }

  private readCurrentTime(): number {
    const value = this.player?.getCurrentTime() ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  private currentVideoId(): string | null {
    return parseYouTubeLink(this.player?.getVideoUrl() ?? '')?.videoId ?? null;
  }

  private isStaleEvent(): boolean {
    if (this.previousVideoId === null || this.plan === null) {
      return false;
    }
    const current = this.currentVideoId();
    return (
      current !== null &&
      current === this.previousVideoId &&
      current !== this.plan.videoId
    );
  }

  private applyAudio(): void {
    if (this.player === null) {
      return;
    }
    try {
      if (this.audioSuppressed) {
        // The pre-start prebuffer stays silent even if the user moves volume
        // or mute; their values are restored verbatim at the real start.
        this.player.mute();
        this.player.setVolume(0);
        return;
      }
      this.player.setVolume(this.volume);
      if (this.muted) {
        this.player.mute();
      } else {
        this.player.unMute();
      }
    } catch {
      // A destroyed player throws; audio is re-applied on the next ready.
    }
  }

  /**
   * M4 AK-7: during the preroll the player is warmed with a *muted* pre-start
   * play so the stream is buffered before the agreed start. Only the
   * controller's own CUED makes this legal; a late join, a host pause, a
   * terminal state or too little remaining lead all skip it.
   */
  private maybePrebuffer(gen: number): void {
    if (this.destroyed || gen !== this.generation || this.plan === null) {
      return;
    }
    if (
      this.player === null ||
      !this.cueReady ||
      this.prebufferEngaged ||
      this.observedStartAt !== null
    ) {
      return;
    }
    if (this.plan.pausedAt !== null) {
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    const now = this.options.serverNow();
    if (now >= this.plan.startAt) {
      return;
    }
    if (this.plan.startAt - now < PREBUFFER_MIN_LEAD_MS) {
      return;
    }
    this.prebufferEngaged = true;
    this.audioSuppressed = true;
    this.applyAudio();
    this.prebufferPlayIssued = true;
    try {
      this.player.playVideo();
    } catch {
      // A destroyed player throws; the real start still reports honestly.
    }
  }

  /**
   * Schedules the real start `playVideo` at `startAt - START_LEAD_MS`, while
   * audio stays suppressed, so the media is already running at the unmute.
   */
  private armStartLead(gen: number): void {
    if (this.plan === null) {
      return;
    }
    if (this.startLeadTimer !== null) {
      this.scheduler.clearTimeout(this.startLeadTimer);
    }
    const delay = Math.max(
      0,
      this.plan.startAt - START_LEAD_MS - this.options.serverNow(),
    );
    this.startLeadTimer = this.scheduler.setTimeout(() => {
      this.startLeadTimer = null;
      this.issueStartPlay(gen);
    }, delay);
  }

  /** Issues the muted real start play; its PLAYING is what unmutes at startAt. */
  private issueStartPlay(gen: number): void {
    if (
      this.destroyed ||
      gen !== this.generation ||
      this.plan === null ||
      this.player === null
    ) {
      return;
    }
    if (this.plan.pausedAt !== null || this.observedStartAt !== null) {
      return;
    }
    if (this.status === 'skipped' || this.status === 'ended') {
      return;
    }
    if (!this.prebufferEngaged || this.startPlayIssued) {
      return;
    }
    this.startPlayIssued = true;
    this.audioSuppressed = true;
    this.applyAudio();
    try {
      this.player.playVideo();
    } catch {
      // A destroyed player throws; the real start still reports honestly.
    }
  }

  /** Drops warm-up bookkeeping but keeps the player silent until startAt. */
  private cancelPrebuffer(): void {
    if (this.startLeadTimer !== null) {
      this.scheduler.clearTimeout(this.startLeadTimer);
      this.startLeadTimer = null;
    }
    this.prebufferEngaged = false;
    this.prebufferPlayIssued = false;
    this.startPlayIssued = false;
    this.prebufferRunning = false;
  }

  /** Abandons the prebuffer and ends the silence early (blocked/native case). */
  private abandonPrebuffer(): void {
    this.cancelPrebuffer();
    this.restoreAudio();
  }

  /** Ends the pre-start silence: hands the user's own volume/mute back. */
  private restoreAudio(): void {
    if (!this.audioSuppressed) {
      return;
    }
    this.audioSuppressed = false;
    this.applyAudio();
  }

  private setStatus(status: PlaybackStatus): void {
    this.status = status;
    this.refresh();
    this.emit();
  }

  private emit(): void {
    if (this.destroyed) {
      return;
    }
    this.options.onDiagnostics({
      status: this.status,
      observedStartAt: this.observedStartAt,
      startSkewMs: this.startSkewMs,
      driftMs: this.driftMs,
      currentSeconds: this.currentSecondsValue,
      expectedSeconds: this.expectedSecondsValue,
      errorCode: this.errorCode,
    });
  }

  private createReadyGate(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(
      () =>
        reject(
          new PreviewError(
            'PLAYER_TIMEOUT',
            'YouTube player did not become ready in time',
          ),
        ),
      PLAYER_TIMEOUT_MS,
    );
    this.readyResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    this.readyReject = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    return promise;
  }

  private releaseReady(error?: PreviewError): void {
    if (error !== undefined) {
      this.readyReject?.(error);
    } else {
      this.readyResolve?.();
    }
    this.readyResolve = null;
    this.readyReject = null;
  }

  private clearTimers(): void {
    if (this.startTimer !== null) {
      this.scheduler.clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.startLeadTimer !== null) {
      this.scheduler.clearTimeout(this.startLeadTimer);
      this.startLeadTimer = null;
    }
    if (this.pollTimer !== null) {
      this.scheduler.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.deadlineTimer !== null) {
      this.scheduler.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }
}

export async function createPlayback(
  container: HTMLElement,
  options: PlaybackOptions,
): Promise<PlaybackController> {
  const session = new PlaybackSession(container, options);
  await session.start();
  return session;
}
