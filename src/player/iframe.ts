/**
 * Shared YouTube IFrame lifecycle (NFR-01, FR-35). The official API script is
 * loaded lazily and exactly once for the whole page; every preview and every
 * synchronized playback player reuses the same singleton promise. The embed is
 * always served from the privacy enhanced `youtube-nocookie.com` origin with a
 * strict referrer policy, so this module is the single place that owns iframe
 * construction and API injection.
 */

export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
export const IFRAME_ORIGIN = 'https://www.youtube-nocookie.com';
export const SCRIPT_TIMEOUT_MS = 10_000;

export type PreviewErrorCode =
  | 'ABORTED'
  | 'INVALID_OPTIONS'
  | 'SCRIPT_LOAD'
  | 'SCRIPT_TIMEOUT'
  | 'PLAYER_TIMEOUT';

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

/** Options object accepted by `player.cueVideoById`. */
export interface YouTubeCueOptions {
  videoId: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  cueVideoById(options: YouTubeCueOptions): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoUrl(): string;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}

export interface YouTubeEvent {
  target: YouTubePlayer;
  data?: number;
}

export interface YouTubePlayerEvents {
  onReady?: (event: YouTubeEvent) => void;
  onStateChange?: (event: YouTubeEvent) => void;
  onError?: (event: YouTubeEvent) => void;
  onAutoplayBlocked?: (event: YouTubeEvent) => void;
}

export interface YouTubeApi {
  Player: new (
    element: HTMLElement | string,
    options: { events?: YouTubePlayerEvents },
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApiPromise: Promise<YouTubeApi> | null = null;

function hasYouTubePlayer(api: unknown): api is YouTubeApi {
  return (
    typeof api === 'object' &&
    api !== null &&
    'Player' in api &&
    typeof api.Player === 'function'
  );
}

/**
 * Injects the official API script exactly once. The promise is shared by every
 * caller and reset after a failed load so a later attempt can retry.
 */
export function loadIframeApi(): Promise<YouTubeApi> {
  if (iframeApiPromise !== null) {
    return iframeApiPromise;
  }
  if (hasYouTubePlayer(window.YT)) {
    iframeApiPromise = Promise.resolve(window.YT);
    return iframeApiPromise;
  }
  const { promise, resolve, reject } = Promise.withResolvers<YouTubeApi>();
  iframeApiPromise = promise;
  const previous = window.onYouTubeIframeAPIReady;
  const script = document.createElement('script');
  let settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    script.removeEventListener('error', fail);
    if (window.onYouTubeIframeAPIReady === ready) {
      window.onYouTubeIframeAPIReady = previous;
    }
  };
  const rejectLoad = (error: PreviewError) => {
    if (settled) return;
    settled = true;
    cleanup();
    script.remove();
    iframeApiPromise = null;
    reject(error);
  };
  const fail = () =>
    rejectLoad(
      new PreviewError(
        'SCRIPT_LOAD',
        'YouTube iframe API script failed to load',
      ),
    );
  const ready = () => {
    if (settled) return;
    if (!hasYouTubePlayer(window.YT)) {
      rejectLoad(
        new PreviewError(
          'SCRIPT_LOAD',
          'YouTube iframe API exposed no YT.Player',
        ),
      );
      return;
    }
    settled = true;
    cleanup();
    resolve(window.YT);
    previous?.();
  };
  const timer = setTimeout(
    () =>
      rejectLoad(
        new PreviewError('SCRIPT_TIMEOUT', 'YouTube iframe API load timed out'),
      ),
    SCRIPT_TIMEOUT_MS,
  );
  window.onYouTubeIframeAPIReady = ready;
  script.src = IFRAME_API_URL;
  script.async = true;
  script.addEventListener('error', fail);
  document.head.append(script);
  return iframeApiPromise;
}

export function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  const { promise: cancellable, resolve, reject } = Promise.withResolvers<T>();
  const abort = () =>
    reject(
      new PreviewError(
        'ABORTED',
        'Aborted while loading the YouTube IFrame API',
      ),
    );
  if (signal.aborted) {
    abort();
    return cancellable;
  }
  signal.addEventListener('abort', abort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    },
  );
  return cancellable;
}

/**
 * Builds the privacy enhanced embed. `origin` is required for the postMessage
 * API handshake; `strict-origin-when-cross-origin` keeps the referrer minimal.
 */
export function createYouTubeIframe(
  videoId: string,
  title: string,
  startSeconds = 0,
): HTMLIFrameElement {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: location.origin,
    playsinline: '1',
  });
  if (startSeconds > 0) {
    params.set('start', String(Math.floor(startSeconds)));
  }
  const iframe = document.createElement('iframe');
  iframe.src = `${IFRAME_ORIGIN}/embed/${videoId}?${params.toString()}`;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.title = title;
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '270px';
  return iframe;
}
