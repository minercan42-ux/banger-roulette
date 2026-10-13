import type { BrowserContext, Page } from '@playwright/test';

/**
 * Deterministic stand-in for the *external* YouTube boundary. The real
 * `src/player/preview.ts` / `src/player/playback.ts` lifecycle is exercised
 * unchanged: it lazy-loads `https://www.youtube.com/iframe_api`, builds a
 * `youtube-nocookie.com` iframe and drives the official `YT.Player` surface.
 * Only the bytes crossing the network edge are replaced, so no production seam
 * is introduced.
 *
 * The same-origin `/api/oembed` proxy is intercepted too, because it is the one
 * place the app reads YouTube metadata (FR-21). Nothing here ships in the build.
 *
 * M4 additions: the player now models a *real* playback clock (cue, buffering,
 * an independently advancing position, `getVideoUrl` identity, volume/mute and
 * the `onAutoplayBlocked` gate). The advancing clock is driven by
 * `performance.now()`, so it keeps running even when a test shifts the page's
 * wall clock (`Date.now`) to simulate per-client clock skew (FR-31).
 */
export interface YouTubeVideoFixture {
  /** Positive playback duration reported once metadata is ready; default 200. */
  duration?: number;
  /** Error code surfaced through `onError` (2/100/101/150/5); default none. */
  error?: number;
  /** Milliseconds before `onReady` fires; default 0. */
  readyDelayMs?: number;
  /** Milliseconds after ready (or cue) before `onError` fires; default 50. */
  errorDelayMs?: number;
  /**
   * Position (seconds) the video starts at; the reported clock then advances
   * from here while playing. Read once before any seek; default 0.
   */
  currentSeconds?: number;
  /** Normalized title served by `/api/oembed`; default `Fixture <videoId>`. */
  title?: string;
  /** Normalized channel served by `/api/oembed`; default `Fixture Channel`. */
  channel?: string;
  /**
   * Milliseconds between `cueVideoById` and the CUED state change; a value
   * larger than the preroll simulates a late cue that must be caught up.
   * Default 0.
   */
  cueDelayMs?: number;
  /**
   * Milliseconds of BUFFERING before the audible start. It lands on the first
   * *unmuted* play, or on the muted *resume* after the prebuffer rewind (a
   * resumed clip buffers even while muted), once per cue; the position freezes
   * meanwhile, so a large value simulates buffering recovery. Default 0.
   */
  bufferingMs?: number;
  /**
   * Signed milliseconds the reported position is offset from the timeline when
   * audible playback begins (positive = ahead, e.g. an ad overshoot). Injected
   * once per cue when the media first becomes audible (the unmute), so the muted
   * pre-start warm-up does not consume it. A magnitude over 750 must trigger a
   * drift `seekTo`; below must not. Default 0.
   */
  startOffsetMs?: number;
  /**
   * When true the first scripted `playVideo` fires `onAutoplayBlocked` and the
   * next one (a user gesture via `recover()`) plays. Default false.
   */
  autoplayBlocked?: boolean;
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

/** One recorded low-level player call, in the order the page made it. */
export interface YouTubeCall {
  type:
    | 'ready'
    | 'state'
    | 'cue'
    | 'play'
    | 'pause'
    | 'seek'
    | 'buffering'
    | 'blocked'
    | 'error'
    | 'volume'
    | 'mute'
    | 'unmute'
    | 'destroy';
  /** `performance.now()` at the call; monotonic, unaffected by wall clocks. */
  at: number;
  videoId?: string;
  state?: number;
  seconds?: number;
  startSeconds?: number;
  endSeconds?: number | null;
  code?: number;
  value?: number;
  muted?: boolean;
}

declare global {
  interface Window {
    __bangerYtFixture?: YouTubeFixtureMap;
    __bangerYtCalls?: YouTubeCall[];
  }
}

/**
 * Served in place of the official IFrame API script. It mirrors the documented
 * surface `preview.ts` and `playback.ts` bind to: `window.YT.Player`
 * constructed with the embed iframe and an `events` bag, `onReady`,
 * `onStateChange` (PLAYING = 1), `onError` (codes), `onAutoplayBlocked`,
 * `cueVideoById`/`playVideo`/`pauseVideo`/`seekTo`/`getCurrentTime`/
 * `getDuration`/`getVideoUrl`/`getPlayerState`/`getVideoData`/volume/mute.
 */
const IFRAME_API_FIXTURE = `
(function () {
  var STATES = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  function perfNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function fixMap() { return window.__bangerYtFixture || {}; }
  var callLog = (window.__bangerYtCalls = window.__bangerYtCalls || []);
  function record(type, extra) {
    var entry = { type: type, at: perfNow() };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) entry[key] = extra[key];
      }
    }
    callLog.push(entry);
    return entry;
  }
  function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }
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
    var entry = fixMap()[videoId] || {};
    return {
      error: num(entry.error, 0),
      duration: num(entry.duration, 200),
      readyDelayMs: num(entry.readyDelayMs, 0),
      errorDelayMs: num(entry.errorDelayMs, 50),
      cueDelayMs: num(entry.cueDelayMs, 0),
      bufferingMs: num(entry.bufferingMs, 0),
      startOffsetMs: num(entry.startOffsetMs, 0),
      autoplayBlocked: entry.autoplayBlocked === true,
      currentSeconds: num(entry.currentSeconds, 0)
    };
  }
  function Player(element, options) {
    var self = this;
    var events = (options && options.events) || {};
    this.events = events;
    this.videoId = videoIdFromElement(element);
    this.cfg = cfgFor(this.videoId);
    this.destroyed = false;
    this.readyFired = false;
    this.firedError = false;
    this.metadataReady = false;
    this.state = STATES.UNSTARTED;
    this.playing = false;
    this.pendingPlay = false;
    this.buffered = false;
    this.blocked = false;
    this.unblocked = false;
    this.endSeconds = null;
    this.cueStart = startFromElement(element) || this.cfg.currentSeconds;
    this.baseSeconds = this.cueStart;
    this.baseAt = perfNow();
    this.pausedSeconds = this.cueStart;
    this.volume = 100;
    this.muted = false;
    this.offsetApplied = false;
    this.timers = [];
    var ready = function () {
      if (self.destroyed || self.readyFired) return;
      self.readyFired = true;
      self.metadataReady = true;
      record('ready', { videoId: self.videoId });
      if (typeof events.onReady === 'function') events.onReady({ target: self });
      self.emitState(STATES.CUED);
      if (self.cfg.error) self.scheduleError();
    };
    this.later(ready, this.cfg.readyDelayMs);
  }
  Player.prototype.later = function (handler, ms) {
    var self = this;
    var id = setTimeout(function () {
      self.timers = self.timers.filter(function (candidate) { return candidate !== id; });
      handler();
    }, Math.max(0, ms));
    this.timers.push(id);
    return id;
  };
  Player.prototype.emitState = function (state) {
    if (this.destroyed) return;
    this.state = state;
    record('state', { videoId: this.videoId, state: state });
    if (typeof this.events.onStateChange === 'function') {
      this.events.onStateChange({ target: this, data: state });
    }
  };
  Player.prototype.scheduleError = function () {
    var self = this;
    if (this.firedError || this.errorTimer) return;
    this.errorTimer = this.later(function () { self.emitError(self.cfg.error); }, this.cfg.errorDelayMs);
  };
  Player.prototype.emitError = function (code) {
    if (this.destroyed || this.firedError) return;
    this.firedError = true;
    this.playing = false;
    record('error', { videoId: this.videoId, code: code });
    if (typeof this.events.onError === 'function') this.events.onError({ target: this, data: code });
  };
  Player.prototype.cueVideoById = function (input) {
    var self = this;
    if (this.destroyed) return;
    var videoId = typeof input === 'string' ? input : (input && input.videoId) || '';
    var start = (input && typeof input === 'object') ? num(input.startSeconds, 0) : 0;
    var end = (input && typeof input === 'object' && typeof input.endSeconds === 'number') ? input.endSeconds : null;
    this.videoId = videoId;
    this.cfg = cfgFor(videoId);
    this.endSeconds = end;
    this.metadataReady = false;
    this.playing = false;
    this.pendingPlay = false;
    this.buffered = false;
    this.firedError = false;
    this.errorTimer = null;
    this.cueStart = start;
    this.baseSeconds = start;
    this.pausedSeconds = start;
    this.offsetApplied = false;
    this.state = STATES.UNSTARTED;
    record('cue', { videoId: videoId, startSeconds: start, endSeconds: end });
    this.later(function () {
      if (self.destroyed) return;
      self.metadataReady = true;
      self.emitState(STATES.CUED);
      if (self.cfg.error) self.scheduleError();
      if (self.pendingPlay) { self.pendingPlay = false; self.startPlayback(); }
    }, this.cfg.cueDelayMs);
  };
  Player.prototype.playVideo = function () {
    if (this.destroyed) return;
    record('play', { videoId: this.videoId, pending: !this.metadataReady, muted: this.muted });
    if (!this.metadataReady) { this.pendingPlay = true; return; }
    this.startPlayback();
  };
  Player.prototype.startPlayback = function () {
    var self = this;
    if (this.destroyed || this.firedError) return;
    // Muted autoplay is permitted by policy; only an audible (unmuted) play is
    // blocked, so the muted prebuffer never consumes the single blocked signal.
    if (this.cfg.autoplayBlocked && !this.unblocked && !this.muted) {
      this.unblocked = true;
      this.blocked = true;
      record('blocked', { videoId: this.videoId });
      if (typeof this.events.onAutoplayBlocked === 'function') {
        this.events.onAutoplayBlocked({ target: this });
      }
      return;
    }
    if (this.playing) return;
    // Buffering models the first (muted pre-roll or cold) playback start of the
    // clip stalling, once per cue; the position freezes meanwhile.
    if (this.cfg.bufferingMs > 0 && !this.buffered) {
      this.buffered = true;
      this.emitState(STATES.BUFFERING);
      this.later(function () { self.beginsPlaying(); }, this.cfg.bufferingMs);
      return;
    }
    this.beginsPlaying();
  };
  Player.prototype.beginsPlaying = function () {
    if (this.destroyed || this.playing || this.firedError) return;
    this.playing = true;
    // Resume from where the player was paused (or a rewind seek moved it),
    // never from the original cue start.
    this.baseSeconds = this.pausedSeconds;
    this.baseAt = perfNow();
    this.emitState(STATES.PLAYING);
  };
  Player.prototype.position = function () {
    if (!this.playing) return this.pausedSeconds;
    return Math.min(
      this.cfg.duration,
      this.baseSeconds + (perfNow() - this.baseAt) / 1000,
    );
  };
  Player.prototype.pauseVideo = function () {
    if (this.destroyed) return;
    record('pause', { videoId: this.videoId });
    if (this.playing) {
      this.pausedSeconds = this.position();
      this.playing = false;
    }
    this.emitState(STATES.PAUSED);
  };
  Player.prototype.seekTo = function (seconds, allowSeekAhead) {
    if (this.destroyed) return;
    if (typeof seconds !== 'number' || !isFinite(seconds)) return;
    record('seek', { videoId: this.videoId, seconds: seconds });
    if (this.playing) {
      // While playing: the position jumps and playback continues.
      this.baseSeconds = seconds;
      this.baseAt = perfNow();
      if (this.cfg.bufferingMs > 0) {
        var self = this;
        this.emitState(STATES.BUFFERING);
        this.later(function () { if (!self.destroyed) self.emitState(STATES.PLAYING); }, 30);
      }
      return;
    }
    this.pausedSeconds = seconds;
    this.baseSeconds = seconds;
    // Official docs: seeking from CUED/UNSTARTED starts playback, while a seek
    // from PAUSED leaves the player paused.
    if (this.state === STATES.CUED || this.state === STATES.UNSTARTED) {
      this.startPlayback();
    }
  };
  Player.prototype.getCurrentTime = function () {
    var value = this.position();
    return isFinite(value) ? value : 0;
  };
  Player.prototype.getDuration = function () { return this.metadataReady ? this.cfg.duration : 0; };
  Player.prototype.getVideoUrl = function () { return 'https://www.youtube.com/watch?v=' + this.videoId; };
  Player.prototype.getPlayerState = function () { return this.state; };
  Player.prototype.getVideoData = function () { return { video_id: this.videoId }; };
  Player.prototype.setVolume = function (value) {
    var clamped = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!isFinite(clamped)) return;
    this.volume = clamped;
    record('volume', { videoId: this.videoId, value: clamped });
  };
  Player.prototype.getVolume = function () { return this.volume; };
  Player.prototype.mute = function () { this.muted = true; record('mute', { videoId: this.videoId }); };
  Player.prototype.unMute = function () {
    this.muted = false;
    // The injected start offset models an audible-start overshoot: it lands when
    // the media first becomes audible, once per cue.
    if (!this.offsetApplied) {
      this.offsetApplied = true;
      var offset = num(this.cfg.startOffsetMs, 0) / 1000;
      if (offset !== 0) {
        this.baseSeconds = this.position() + offset;
        this.baseAt = perfNow();
        if (!this.playing) this.pausedSeconds = this.baseSeconds;
      }
    }
    record('unmute', { videoId: this.videoId });
  };
  Player.prototype.isMuted = function () { return this.muted; };
  Player.prototype.destroy = function () {
    this.destroyed = true;
    var timers = this.timers;
    this.timers = [];
    for (var index = 0; index < timers.length; index += 1) clearTimeout(timers[index]);
    record('destroy', { videoId: this.videoId });
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
    window.__bangerYtCalls = [];
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

/** Every low-level player call the page has made so far, in order. */
export function youTubeCalls(page: Page): Promise<YouTubeCall[]> {
  return page.evaluate(() => window.__bangerYtCalls ?? []);
}

/**
 * Fails the next `times` `/iframe_api` loads on this page, then lets the shared
 * fixture serve them again. Models a transient API-load failure so a caller can
 * prove a failed creation is retried instead of staying skipped.
 */
export async function failIframeApi(page: Page, times = 1): Promise<void> {
  let remaining = times;
  await page.route(
    (url) => url.pathname === '/iframe_api',
    (route) => {
      if (remaining > 0) {
        remaining -= 1;
        return route.abort('failed');
      }
      return route.fallback();
    },
  );
}

/**
 * Replaces one video's behaviour at runtime. The fixture reads
 * `window.__bangerYtFixture` on every cue, so a later song can be given an
 * error (or other behaviour) once the playback order is known.
 */
export async function setFixtureVideo(
  page: Page,
  videoId: string,
  fixture: YouTubeVideoFixture,
): Promise<void> {
  await page.evaluate(
    ([id, settings]) => {
      window.__bangerYtFixture = window.__bangerYtFixture ?? {};
      window.__bangerYtFixture[id] = settings;
    },
    [videoId, fixture] as const,
  );
}
