import { VideoId } from '../shared/primitives';
import { parseYouTubeLink } from './links';
import {
  awaitWithAbort,
  createYouTubeIframe,
  loadIframeApi,
  PreviewError,
} from './iframe';
import type { YouTubeApi, YouTubeEvent, YouTubePlayer } from './iframe';

export { PreviewError };
export type { PreviewErrorCode } from './iframe';

const PLAYER_TIMEOUT_MS = 10_000;
const DURATION_PROBE_MS = 4_000;
const DURATION_POLL_INTERVAL_MS = 100;
const YOUTUBE_STATE_PLAYING = 1;

/**
 * Error codes that prove the video cannot be embedded (FR-22). 5, 153 and
 * unknown codes are environmental and never mark a submission as valid.
 */
export const PREVIEW_BLOCKING_ERROR_CODES: readonly number[] = [
  2, 100, 101, 150,
];

export function isBlockingPreviewError(code: number): boolean {
  return PREVIEW_BLOCKING_ERROR_CODES.includes(code);
}

export type PreviewStatus =
  | { type: 'ready' }
  | { type: 'playing'; durationSeconds: number }
  | { type: 'error'; code: number }
  | { type: 'autoplayBlocked' };

export interface PreviewPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  currentTime(): number;
  duration(): number;
  videoId(): string | null;
  destroy(): void;
}

export interface PreviewOptions {
  videoId: string;
  startSeconds: number;
  title: string;
  onStatus: (status: PreviewStatus) => void;
  signal?: AbortSignal;
}

class PreviewSession implements PreviewPlayer {
  private destroyed = false;
  private player: YouTubePlayer | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private durationTimer: number | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: PreviewError) => void) | null = null;
  private initializationError: number | null = null;
  private readonly abortListener = () => this.destroy();

  constructor(
    private readonly container: HTMLElement,
    private readonly options: PreviewOptions,
  ) {}

  async start(): Promise<void> {
    if (
      !this.container ||
      !VideoId.safeParse(this.options.videoId).success ||
      !Number.isFinite(this.options.startSeconds) ||
      this.options.startSeconds < 0
    ) {
      throw new PreviewError('INVALID_OPTIONS', 'Invalid preview options');
    }
    if (this.options.signal?.aborted === true) {
      throw new PreviewError('ABORTED', 'Preview aborted before start');
    }
    this.options.signal?.addEventListener('abort', this.abortListener, {
      once: true,
    });

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
        'Preview aborted while loading the API',
      );
    }

    const iframe = createYouTubeIframe(
      this.options.videoId,
      this.options.title,
      this.options.startSeconds,
    );
    this.iframe = iframe;
    this.container.append(iframe);
    const ready = this.createReadyGate();
    // A synchronous construction failure below never awaits `ready`; keep the
    // gate's rejection handled so it cannot surface as an unhandled rejection.
    void ready.catch(() => undefined);
    try {
      this.player = new api.Player(iframe, {
        events: {
          onReady: () => this.handleReady(),
          onStateChange: (event) => this.handleStateChange(event),
          onError: (event) => this.handleError(event),
          onAutoplayBlocked: () => this.emit({ type: 'autoplayBlocked' }),
        },
      });
      await ready;
    } catch (error) {
      this.destroy();
      throw error;
    }
    if (this.initializationError === null) {
      this.emit({ type: 'ready' });
    }
  }

  play(): void {
    if (!this.destroyed) {
      this.player?.playVideo();
    }
  }

  pause(): void {
    if (!this.destroyed) {
      this.player?.pauseVideo();
    }
  }

  seek(seconds: number): void {
    if (this.destroyed || !Number.isFinite(seconds) || seconds < 0) {
      return;
    }
    this.player?.seekTo(seconds, true);
  }

  currentTime(): number {
    const value = this.player?.getCurrentTime() ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  duration(): number {
    const value = this.player?.getDuration() ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  videoId(): string | null {
    return parseYouTubeLink(this.player?.getVideoUrl() ?? '')?.videoId ?? null;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.clearDurationProbe();
    this.options.signal?.removeEventListener('abort', this.abortListener);
    this.readyReject?.(new PreviewError('ABORTED', 'Preview destroyed'));
    this.readyResolve = null;
    this.readyReject = null;
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

  private handleReady(): void {
    if (this.destroyed) {
      return;
    }
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private handleStateChange(event: YouTubeEvent): void {
    if (this.destroyed || event.data !== YOUTUBE_STATE_PLAYING) {
      return;
    }
    this.beginDurationProbe();
  }

  private handleError(event: YouTubeEvent): void {
    if (this.destroyed) {
      return;
    }
    this.clearDurationProbe();
    this.initializationError = event.data ?? 0;
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
    this.emit({ type: 'error', code: event.data ?? 0 });
  }

  /**
   * `getDuration()` returns 0 until the video metadata has loaded, which is
   * normally just after playback starts. Probe until a positive finite
   * duration proves the current video plays, then surface it once.
   */
  private beginDurationProbe(): void {
    this.clearDurationProbe();
    const deadline = Date.now() + DURATION_PROBE_MS;
    const probe = () => {
      if (this.destroyed) {
        return;
      }
      if (this.videoId() !== this.options.videoId) {
        this.clearDurationProbe();
        this.emit({ type: 'error', code: 0 });
        return;
      }
      const duration = this.duration();
      if (duration > 0) {
        this.clearDurationProbe();
        this.emit({ type: 'playing', durationSeconds: duration });
        return;
      }
      if (Date.now() >= deadline) {
        this.clearDurationProbe();
        this.emit({ type: 'error', code: 5 });
        return;
      }
      this.durationTimer = setTimeout(
        probe,
        DURATION_POLL_INTERVAL_MS,
      ) as unknown as number;
    };
    probe();
  }

  private clearDurationProbe(): void {
    if (this.durationTimer !== null) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private emit(status: PreviewStatus): void {
    if (!this.destroyed) {
      this.options.onStatus(status);
    }
  }
}

export async function createPreview(
  container: HTMLElement,
  options: PreviewOptions,
): Promise<PreviewPlayer> {
  const session = new PreviewSession(container, options);
  await session.start();
  return session;
}
