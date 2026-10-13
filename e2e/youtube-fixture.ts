import type { BrowserContext, Page } from '@playwright/test';

/**
 * Deterministic stand-in for the *external* YouTube boundary. The real
 * `src/player/preview.ts` lifecycle is exercised unchanged: it lazy-loads
 * `https://www.youtube.com/iframe_api`, builds a `youtube-nocookie.com` iframe
 * and drives the official `YT.Player` surface. Only the bytes crossing the
 * network edge are replaced, so no production seam is introduced.
 *
 * The same-origin `/api/oembed` proxy is intercepted too, because it is the one
 * place the app reads YouTube metadata (FR-21). Nothing here ships in the build.
 */
export interface YouTubeVideoFixture {
  /** Positive playback duration reported once PLAYING; default 200. */
  duration?: number;
  /** Error code surfaced through `onError` (2/100/101/150/5); default none. */
  error?: number;
  /** Milliseconds before `onReady` fires; default 0. */
  readyDelayMs?: number;
  /** Milliseconds after ready before `onError` fires; default 50. */
  errorDelayMs?: number;
  /** Playback position reported by `getCurrentTime` before any seek; default 0. */
  currentSeconds?: number;
  /** Normalized title served by `/api/oembed`; default `Fixture <videoId>`. */
  title?: string;
  /** Normalized channel served by `/api/oembed`; default `Fixture Channel`. */
  channel?: string;
}

export type YouTubeFixtureMap = Record<string, YouTubeVideoFixture>;

/** Hosts that count as external YouTube traffic for the consent assertion. */
export const EXTERNAL_YOUTUBE_HOSTS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'ytimg.com',
  'i.ytimg.com',
  'googlevideo.com',
];

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Normalized channel every fixture `/api/oembed` response reports. */
export const FIXTURE_CHANNEL = 'Fixture Channel';

/** Normalized title contract shared by the fixture proxy and the assertions. */
export function fixtureTitle(videoId: string): string {
  return `Fixture ${videoId}`;
}

/** Thumbnail must satisfy the `Thumbnail` primitive (https i.ytimg.com). */
export function fixtureThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

declare global {
  interface Window {
    __bangerYtFixture?: YouTubeFixtureMap;
  }
}

/**
 * Served in place of the official IFrame API script. It mirrors the documented
 * surface `preview.ts` binds to: `window.YT.Player` constructed with the embed
 * iframe and an `events` bag, `onReady`/`onStateChange` (PLAYING = 1)/`onError`
 * (codes), `getDuration`/`getCurrentTime`/`seekTo`/`playVideo`/`destroy`.
 */
const IFRAME_API_FIXTURE = `
(function () {
  var FIX = window.__bangerYtFixture || {};
  var STATES = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  function elementSrc(element) {
    if (typeof element === 'string') {
      var byId = document.getElementById(element);
      return byId && byId.src ? byId.src : '';
    }
    return element && element.src ? element.src : '';
  }
  function videoIdFromElement(element) {
    var match = /\\/embed\\/([A-Za-z0-9_-]{11})/.exec(elementSrc(element));
    return match ? match[1] : '';
  }
  function startFromElement(element) {
    var match = /[?&]start=(\\d+)/.exec(elementSrc(element));
    return match ? Number(match[1]) : 0;
  }
  function cfgFor(videoId) {
    var entry = FIX[videoId] || {};
    return {
      error: typeof entry.error === 'number' ? entry.error : 0,
      duration: typeof entry.duration === 'number' ? entry.duration : 200,
      readyDelayMs: typeof entry.readyDelayMs === 'number' ? entry.readyDelayMs : 0,
      errorDelayMs: typeof entry.errorDelayMs === 'number' ? entry.errorDelayMs : 50,
      currentSeconds: typeof entry.currentSeconds === 'number' ? entry.currentSeconds : 0
    };
  }
  function Player(element, options) {
    var self = this;
    var events = (options && options.events) || {};
    this.events = events;
    this.videoId = videoIdFromElement(element);
    this.cfg = cfgFor(this.videoId);
    this.destroyed = false;
    this.firedReady = false;
    this.firedError = false;
    this.firedPlaying = false;
    this.state = STATES.UNSTARTED;
    this.current = startFromElement(element) || this.cfg.currentSeconds;
    this.readyTimer = null;
    this.errorTimer = null;
    var ready = function () {
      if (self.destroyed || self.firedReady) return;
      self.firedReady = true;
      self.state = STATES.CUED;
      if (typeof events.onReady === 'function') events.onReady({ target: self });
      if (self.cfg.error) {
        self.errorTimer = setTimeout(function () { self.emitError(self.cfg.error); }, self.cfg.errorDelayMs);
      }
    };
    this.readyTimer = setTimeout(ready, this.cfg.readyDelayMs);
  }
  Player.prototype.emitError = function (code) {
    if (this.destroyed || this.firedError) return;
    this.firedError = true;
    if (typeof this.events.onError === 'function') this.events.onError({ target: this, data: code });
  };
  Player.prototype.playVideo = function () {
    var self = this;
    if (this.destroyed || this.firedPlaying) return;
    if (this.cfg.error) {
      this.errorTimer = setTimeout(function () { self.emitError(self.cfg.error); }, this.cfg.errorDelayMs);
      return;
    }
    setTimeout(function () {
      if (self.destroyed) return;
      self.firedPlaying = true;
      self.state = STATES.PLAYING;
      if (typeof self.events.onStateChange === 'function') {
        self.events.onStateChange({ target: self, data: STATES.PLAYING });
      }
    }, 0);
  };
  Player.prototype.pauseVideo = function () {
    this.state = STATES.PAUSED;
    if (typeof this.events.onStateChange === 'function') {
      this.events.onStateChange({ target: this, data: STATES.PAUSED });
    }
  };
  Player.prototype.seekTo = function (seconds) {
    if (typeof seconds === 'number' && isFinite(seconds)) this.current = seconds;
  };
  Player.prototype.getCurrentTime = function () { return this.current; };
  Player.prototype.getDuration = function () { return this.cfg.duration; };
  Player.prototype.getVideoUrl = function () { return 'https://www.youtube.com/watch?v=' + this.videoId; };
  Player.prototype.getPlayerState = function () { return this.state; };
  Player.prototype.getVideoData = function () { return { video_id: this.videoId }; };
  Player.prototype.mute = function () {};
  Player.prototype.unMute = function () {};
  Player.prototype.setVolume = function () {};
  Player.prototype.destroy = function () {
    this.destroyed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.errorTimer) clearTimeout(this.errorTimer);
  };
  Player.PlayerState = STATES;
  window.YT = { Player: Player, PlayerState: STATES, loaded: 1, ready: function (fn) { if (typeof fn === 'function') setTimeout(fn, 0); } };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();
`;

const EMBED_HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

/**
 * Installs the boundary on a context before its first navigation: per-video
 * behaviour for the iframe API script, the embed document, the thumbnail host
 * and the same-origin oEmbed proxy.
 */
export async function installYouTubeFixture(
  context: BrowserContext,
  videos: YouTubeFixtureMap,
): Promise<void> {
  await context.addInitScript((map) => {
    window.__bangerYtFixture = map;
  }, videos);

  await context.route(
    (url) => url.pathname === '/iframe_api',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: IFRAME_API_FIXTURE,
      }),
  );

  await context.route(
    (url) =>
      url.hostname === 'www.youtube-nocookie.com' &&
      url.pathname.startsWith('/embed/'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: EMBED_HTML,
      }),
  );

  await context.route(
    (url) => url.hostname === 'i.ytimg.com',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'),
      }),
  );

  await context.route(
    (url) => url.pathname === '/api/oembed',
    (route) => {
      const videoId = new URL(route.request().url()).searchParams.get(
        'videoId',
      );
      if (videoId === null || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'INVALID_VIDEO_ID' }),
        });
      }
      const entry = videos[videoId];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          videoId,
          title: entry?.title ?? fixtureTitle(videoId),
          channel: entry?.channel ?? FIXTURE_CHANNEL,
          thumbnail: fixtureThumbnail(videoId),
        }),
      });
    },
  );
}

/**
 * Records every external YouTube request a page attempts, so a test can assert
 * the consent gate *before* anything is fetched. Interception still fires these
 * request events, which is exactly what we want to count.
 */
export function watchYouTubeRequests(page: Page): () => string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (
      url.pathname === '/api/oembed' ||
      EXTERNAL_YOUTUBE_HOSTS.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      seen.push(request.url());
    }
  });
  return () => [...seen];
}
