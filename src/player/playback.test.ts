import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlaybackController,
  PlaybackDiagnostics,
  PlaybackPlan,
  PlaybackStatus,
} from './playback';
import type * as PlaybackModule from './playback';

let createPlayback: typeof PlaybackModule.createPlayback;

const VIDEO_ID = 'M7lc1UVf-VE';
const OTHER_ID = 'dQw4w9WgXcQ';
const T0 = 1_000_000;

interface FakeIframe {
  src: string;
  referrerPolicy: string;
  allow: string;
  allowFullscreen: boolean;
  title: string;
  style: Record<string, string>;
  isConnected: boolean;
  remove(): void;
}

interface FakeEvent {
  target: FakeYTPlayer;
  data?: number;
}

interface FakeEvents {
  onReady?: (event: FakeEvent) => void;
  onStateChange?: (event: FakeEvent) => void;
  onError?: (event: FakeEvent) => void;
  onAutoplayBlocked?: (event: FakeEvent) => void;
}

class FakeYTPlayer {
  static instances: FakeYTPlayer[] = [];
  static initialError: number | null = null;
  static cueError: number | null = null;
  static autoCue = true;
  /** Defers onReady so a test can interleave embed-load state events. */
  static deferReady = false;
  readonly calls: string[] = [];
  current = 0;
  duration = 200;
  videoId = VIDEO_ID;
  volume = 100;
  muted = false;
  destroyed = false;
  private readonly iframe: FakeIframe;
  private readonly events: FakeEvents;

  constructor(iframe: FakeIframe, options: { events: FakeEvents }) {
    this.iframe = iframe;
    this.events = options.events;
    FakeYTPlayer.instances.push(this);
    if (FakeYTPlayer.initialError !== null) {
      this.events.onError?.({ target: this, data: FakeYTPlayer.initialError });
    }
    if (!FakeYTPlayer.deferReady) {
      this.events.onReady?.({ target: this });
    }
  }

  playVideo(): void {
    this.calls.push('play');
  }

  pauseVideo(): void {
    this.calls.push('pause');
  }

  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.calls.push(`seek:${seconds}:${allowSeekAhead}`);
    this.current = seconds;
  }

  cueVideoById(options: {
    videoId: string;
    startSeconds?: number;
    endSeconds?: number;
  }): void {
    this.calls.push(
      `cue:${options.videoId}:${options.startSeconds}:${options.endSeconds}`,
    );
    this.videoId = options.videoId;
    this.current = options.startSeconds ?? 0;
    if (FakeYTPlayer.autoCue) {
      // Real YouTube reports CUED asynchronously; synchronous is enough here.
      this.events.onStateChange?.({ target: this, data: 5 });
    }
    if (FakeYTPlayer.cueError !== null) {
      this.events.onError?.({ target: this, data: FakeYTPlayer.cueError });
    }
  }

  getCurrentTime(): number {
    return this.current;
  }

  getDuration(): number {
    return this.duration;
  }

  getVideoUrl(): string {
    return `https://www.youtube.com/watch?v=${this.videoId}`;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.calls.push(`volume:${volume}`);
  }

  mute(): void {
    this.muted = true;
    this.calls.push('mute');
  }

  unMute(): void {
    this.muted = false;
    this.calls.push('unmute');
  }

  destroy(): void {
    this.destroyed = true;
    this.iframe.isConnected = false;
  }

  ready(): void {
    this.events.onReady?.({ target: this });
  }

  state(data: number): void {
    this.events.onStateChange?.({ target: this, data });
  }

  error(code: number): void {
    this.events.onError?.({ target: this, data: code });
  }

  blocked(): void {
    this.events.onAutoplayBlocked?.({ target: this });
  }
}

class FakeScheduler {
  now: number;
  private readonly timers = new Map<
    number,
    { at: number; handler: () => void }
  >();
  private next = 1;

  constructor(start: number) {
    this.now = start;
  }

  setTimeout(handler: () => void, ms: number): number {
    const id = this.next;
    this.next += 1;
    this.timers.set(id, { at: this.now + ms, handler });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) {
        break;
      }
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.now = dueAt;
      timer?.handler();
    }
    this.now = target;
  }
}

interface Harness {
  windowStub: {
    YT?: { Player: typeof FakeYTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  };
  container: { append(element: unknown): void };
  scripts: unknown[];
  iframes: FakeIframe[];
}

function installDom(): Harness {
  const scripts: unknown[] = [];
  const iframes: FakeIframe[] = [];
  const windowStub: Harness['windowStub'] = {};
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('location', { origin: 'https://app.example' });
  vi.stubGlobal('document', {
    head: { append: (element: unknown) => scripts.push(element) },
    createElement: (tag: string) => {
      if (tag === 'script') {
        return {
          src: '',
          async: false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          remove: vi.fn(),
        };
      }
      const iframe: FakeIframe = {
        src: '',
        referrerPolicy: '',
        allow: '',
        allowFullscreen: false,
        title: '',
        style: {},
        isConnected: false,
        remove() {
          this.isConnected = false;
        },
      };
      iframes.push(iframe);
      return iframe;
    },
  });
  const container = {
    append: (element: unknown) => {
      (element as FakeIframe).isConnected = true;
    },
  };
  return { windowStub, container, scripts, iframes };
}

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    videoId: VIDEO_ID,
    startSeconds: 10,
    clipSeconds: 30,
    startAt: T0,
    deadlineAt: T0 + 30_000,
    pausedAt: null,
    ...overrides,
  };
}

interface Started {
  controller: PlaybackController;
  player: FakeYTPlayer;
  clock: FakeScheduler;
  diagnostics: PlaybackDiagnostics[];
}

async function create(
  harness: Harness,
  playbackPlan: PlaybackPlan,
  options: { now?: number; volume?: number; muted?: boolean } = {},
): Promise<Started> {
  const clock = new FakeScheduler(options.now ?? playbackPlan.startAt - 5_000);
  const diagnostics: PlaybackDiagnostics[] = [];
  const pending = createPlayback(harness.container as unknown as HTMLElement, {
    plan: playbackPlan,
    title: 'Playback',
    serverNow: () => clock.now,
    onDiagnostics: (value) => diagnostics.push(value),
    volume: options.volume,
    muted: options.muted,
    scheduler: clock,
  });
  harness.windowStub.YT = { Player: FakeYTPlayer };
  harness.windowStub.onYouTubeIframeAPIReady?.();
  const controller = await pending;
  const player = FakeYTPlayer.instances.at(-1);
  if (player === undefined) {
    throw new Error('player was never constructed');
  }
  return { controller, player, clock, diagnostics };
}

function statuses(diagnostics: PlaybackDiagnostics[]): PlaybackStatus[] {
  return diagnostics.map((value) => value.status);
}

function hasCall(player: FakeYTPlayer, prefix: string): boolean {
  return player.calls.some((call) => call.startsWith(prefix));
}

beforeEach(async () => {
  FakeYTPlayer.instances = [];
  FakeYTPlayer.initialError = null;
  FakeYTPlayer.cueError = null;
  FakeYTPlayer.autoCue = true;
  FakeYTPlayer.deferReady = false;
  vi.resetModules();
  // The iframe API singleton is module state; a static import would leak it
  // across tests, so the module is re-imported for each isolated case.
  ({ createPlayback } = await import('./playback'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPlayback', () => {
  it('cues but never plays or seeks before the absolute start time', async () => {
    const harness = installDom();
    const playback = plan({ startAt: T0 + 3_000 });
    const { player, clock, diagnostics } = await create(harness, playback, {
      now: playback.startAt - 5_000,
    });

    expect(hasCall(player, 'cue:')).toBe(true);
    expect(hasCall(player, 'play')).toBe(false);
    expect(statuses(diagnostics)).toContain('cued');
    expect(statuses(diagnostics)).toContain('scheduled');

    clock.advance(4_999);
    expect(hasCall(player, 'play')).toBe(false);
    expect(hasCall(player, 'seek:')).toBe(false);
    expect(diagnostics.at(-1)?.observedStartAt).toBeNull();

    clock.advance(1);
    expect(hasCall(player, 'play')).toBe(true);
  });

  it('starts a late join only after its own clip cue, not the embed load', async () => {
    FakeYTPlayer.deferReady = true;
    const harness = installDom();
    const clock = new FakeScheduler(T0 + 5_000);
    const pending = createPlayback(
      harness.container as unknown as HTMLElement,
      {
        plan: plan(),
        title: 'Playback',
        serverNow: () => clock.now,
        onDiagnostics: () => undefined,
        scheduler: clock,
      },
    );
    harness.windowStub.YT = { Player: FakeYTPlayer };
    harness.windowStub.onYouTubeIframeAPIReady?.();
    await vi.waitFor(() => expect(FakeYTPlayer.instances).toHaveLength(1));
    const player = FakeYTPlayer.instances[0]!;
    // The iframe reports its URL video as cued before start() issues the
    // clip cue; acting on it would play, then re-cue and stop the media.
    player.ready();
    player.state(5);
    const controller = await pending;

    const cues = player.calls.filter((call) => call.startsWith('cue:'));
    expect(cues).toHaveLength(1);
    expect(player.calls.indexOf('play')).toBeGreaterThan(
      player.calls.indexOf(cues[0]!),
    );
    controller.destroy();
  });

  it('stops native early playback and starts again on the shared timeline', async () => {
    const harness = installDom();
    const playback = plan({ startAt: T0 + 3_000 });
    const { controller, player, clock, diagnostics } = await create(
      harness,
      playback,
      { now: T0 },
    );

    player.state(1);
    expect(hasCall(player, 'pause')).toBe(true);
    expect(hasCall(player, 'seek:')).toBe(false);
    expect(diagnostics.at(-1)?.observedStartAt).toBeNull();
    clock.advance(3_000);
    expect(hasCall(player, 'play')).toBe(true);
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('playing');
    expect(diagnostics.at(-1)?.observedStartAt).toBe(playback.startAt);
    controller.destroy();
  });

  it('captures the observed start only from a real PLAYING event', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 - 1_000 },
    );

    clock.advance(1_000);
    expect(hasCall(player, 'play')).toBe(true);
    expect(diagnostics.at(-1)?.observedStartAt).toBeNull();

    player.state(1);
    const last = diagnostics.at(-1);
    expect(last?.status).toBe('playing');
    expect(last?.observedStartAt).toBe(T0);
    expect(last?.startSkewMs).toBe(0);
    controller.destroy();
  });

  it('corrects drift above 750 ms and leaves smaller offsets alone', async () => {
    const harness = installDom();
    const { controller, player, clock } = await create(harness, plan(), {
      now: T0,
    });

    player.state(1);
    player.current = 10.75;
    clock.advance(250);
    expect(hasCall(player, 'seek:')).toBe(false);

    player.current = 14;
    clock.advance(250);
    expect(player.calls).toContain(`seek:${10.5}:true`);
    controller.destroy();
  });

  it('does not seek again inside the correction cooldown', async () => {
    const harness = installDom();
    const { controller, player, clock } = await create(harness, plan(), {
      now: T0,
    });

    player.state(1);
    player.current = 20;
    clock.advance(250);
    const firstSeekCount = player.calls.filter((call) =>
      call.startsWith('seek:'),
    ).length;
    expect(firstSeekCount).toBe(1);

    player.current = 30;
    clock.advance(250);
    expect(player.calls.filter((call) => call.startsWith('seek:')).length).toBe(
      firstSeekCount,
    );
    controller.destroy();
  });

  it('stops at the independent deadline even without a YouTube ended event', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    player.state(1);
    clock.advance(30_000);
    expect(hasCall(player, 'pause')).toBe(true);
    expect(diagnostics.at(-1)?.status).toBe('ended');

    // A real PLAYING after the deadline must be stopped again without
    // reviving the clip or claiming a new start.
    const pausesBefore = player.calls.filter((call) => call === 'pause').length;
    const seeksBefore = player.calls.filter((call) =>
      call.startsWith('seek:'),
    ).length;
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('ended');
    expect(player.calls.filter((call) => call.startsWith('seek:')).length).toBe(
      seeksBefore,
    );
    expect(
      player.calls.filter((call) => call === 'pause').length,
    ).toBeGreaterThan(pausesBefore);
    controller.destroy();
  });

  it('cancels a pending start while paused and resumes on shifted timestamps', async () => {
    const harness = installDom();
    const playback = plan({ startAt: T0 + 5_000, deadlineAt: T0 + 35_000 });
    const { controller, player, clock, diagnostics } = await create(
      harness,
      playback,
      { now: T0 },
    );

    clock.advance(1_000);
    controller.update({ ...playback, pausedAt: T0 + 1_000 });
    expect(diagnostics.at(-1)?.status).toBe('paused');

    clock.advance(8_000);
    expect(hasCall(player, 'play')).toBe(false);

    controller.update({
      ...playback,
      startAt: T0 + 13_000,
      deadlineAt: T0 + 43_000,
      pausedAt: null,
    });
    clock.advance(4_000);
    expect(hasCall(player, 'play')).toBe(true);
  });

  it('plays immediately and catches up when joining a song already underway', async () => {
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0 + 5_000,
    });

    expect(hasCall(player, 'play')).toBe(true);
    player.state(1);
    const last = diagnostics.at(-1);
    expect(last?.observedStartAt).toBe(T0 + 5_000);
    expect(last?.startSkewMs).toBe(5_000);
    expect(player.calls).toContain(`seek:${15}:true`);
    controller.destroy();
  });

  it('catches up after buffering once audio is playing again', async () => {
    const harness = installDom();
    const { controller, player, clock } = await create(harness, plan(), {
      now: T0,
    });

    player.state(1);
    player.state(3);
    clock.advance(1_000);
    expect(hasCall(player, 'seek:')).toBe(false);

    player.state(1);
    expect(player.calls).toContain(`seek:${11}:true`);
    controller.destroy();
  });

  it('surfaces autoplay blocking and recovers on a direct gesture', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    clock.advance(0);
    player.blocked();
    expect(diagnostics.at(-1)?.status).toBe('blocked');

    const playsBefore = player.calls.filter((call) => call === 'play').length;
    controller.recover();
    expect(player.calls.filter((call) => call === 'play').length).toBe(
      playsBefore + 1,
    );
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('playing');
    controller.destroy();
  });

  it('treats a per-song error as a local skip without blocking the round', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    clock.advance(0);
    player.state(1);
    player.error(101);
    const skipped = diagnostics.at(-1);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.errorCode).toBe(101);

    // A queued PLAYING after the error must not revive the clip.
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('skipped');

    expect(() =>
      controller.update(plan({ videoId: OTHER_ID, startAt: T0 + 10_000 })),
    ).not.toThrow();
    expect(hasCall(player, `cue:${OTHER_ID}:`)).toBe(true);
  });

  it('resolves creation as skipped when the embed errors before ready', async () => {
    FakeYTPlayer.initialError = 150;
    const harness = installDom();
    const { player, diagnostics } = await create(harness, plan(), { now: T0 });

    expect(diagnostics.at(-1)?.status).toBe('skipped');
    expect(diagnostics.at(-1)?.errorCode).toBe(150);
    expect(hasCall(player, 'cue:')).toBe(false);
    expect(hasCall(player, 'play')).toBe(false);
  });

  it('never seeks into a mismatched current video', async () => {
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0,
    });

    player.videoId = OTHER_ID;
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('skipped');
    expect(hasCall(player, 'seek:')).toBe(false);
    controller.destroy();
  });

  it('ignores an unchanged plan update', async () => {
    const harness = installDom();
    const playback = plan({ startAt: T0 + 5_000 });
    const { controller, diagnostics } = await create(harness, playback, {
      now: T0,
    });

    const before = diagnostics.length;
    controller.update(playback);
    expect(diagnostics).toHaveLength(before);
  });

  it('cues the next song without playing before its own start time', async () => {
    const harness = installDom();
    const { controller, player, clock } = await create(harness, plan(), {
      now: T0,
    });

    player.state(1);
    const next = plan({
      videoId: OTHER_ID,
      startSeconds: 5,
      startAt: T0 + 10_000,
      deadlineAt: T0 + 40_000,
    });
    controller.update(next);
    expect(hasCall(player, `cue:${OTHER_ID}:5:35`)).toBe(true);

    const playsAfterCue = player.calls.filter((call) => call === 'play').length;
    clock.advance(9_999);
    expect(player.calls.filter((call) => call === 'play')).toHaveLength(
      playsAfterCue,
    );
    clock.advance(1);
    expect(player.calls.filter((call) => call === 'play')).toHaveLength(
      playsAfterCue + 1,
    );
    controller.destroy();
  });

  it('ignores stale events from the previous song across a cue switch', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    player.state(1);
    controller.update(
      plan({
        videoId: OTHER_ID,
        startAt: T0 + 10_000,
        deadlineAt: T0 + 40_000,
      }),
    );
    // Simulate the shared player still reporting the previous video while the
    // cue has not taken effect yet.
    player.videoId = VIDEO_ID;
    player.state(0);
    player.state(1);
    player.error(100);
    expect(diagnostics.at(-1)?.status).toBe('scheduled');

    player.videoId = OTHER_ID;
    clock.advance(10_000);
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('playing');
    controller.destroy();
  });

  it('ignores a PLAYING queued after pause and never claims a start', async () => {
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0,
    });

    controller.update({ ...plan(), pausedAt: T0 });
    const pausesBefore = player.calls.filter((call) => call === 'pause').length;
    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('paused');
    expect(diagnostics.at(-1)?.observedStartAt).toBeNull();
    expect(hasCall(player, 'seek:')).toBe(false);
    expect(
      player.calls.filter((call) => call === 'pause').length,
    ).toBeGreaterThan(pausesBefore);
    controller.destroy();
  });

  it('recovers the scheduled timeline after a native (non-host) pause', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    player.state(1);
    expect(diagnostics.at(-1)?.status).toBe('playing');

    // No host pausedAt: this is a local/native pause, not authoritative.
    player.state(2);
    expect(diagnostics.at(-1)?.status).toBe('paused');

    clock.advance(1_000);
    expect(hasCall(player, 'seek:')).toBe(false);

    player.state(1);
    const last = diagnostics.at(-1);
    expect(last?.status).toBe('playing');
    expect(player.calls).toContain(`seek:${11}:true`);
    controller.destroy();
  });

  it('starts on a late cue that lands after the start time', async () => {
    FakeYTPlayer.autoCue = false;
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0 + 2_000,
    });

    // Ready, but not cue-ready: no start, no fabricated evidence.
    expect(hasCall(player, 'play')).toBe(false);
    expect(diagnostics.at(-1)?.status).toBe('cued');

    player.state(5);
    expect(hasCall(player, 'play')).toBe(true);

    player.state(1);
    const last = diagnostics.at(-1);
    expect(last?.status).toBe('playing');
    expect(last?.observedStartAt).toBe(T0 + 2_000);
    expect(player.calls).toContain(`seek:${12}:true`);
    controller.destroy();
  });

  it('never starts a late cue once the deadline has passed', async () => {
    FakeYTPlayer.autoCue = false;
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0 + 40_000,
    });

    expect(diagnostics.at(-1)?.status).toBe('ended');
    expect(hasCall(player, 'play')).toBe(false);

    player.state(5);
    expect(hasCall(player, 'play')).toBe(false);
    expect(diagnostics.at(-1)?.status).toBe('ended');
    controller.destroy();
  });

  it('keeps a local skip terminal across a same-clip update', async () => {
    const harness = installDom();
    const { controller, player, diagnostics } = await create(harness, plan(), {
      now: T0,
    });

    player.state(1);
    player.error(100);
    expect(diagnostics.at(-1)?.status).toBe('skipped');
    expect(hasCall(player, 'play')).toBe(true);

    const cuesBefore = player.calls.filter((call) =>
      call.startsWith('cue:'),
    ).length;
    controller.update({ ...plan(), pausedAt: T0 + 1_000 });
    controller.update({
      ...plan(),
      startAt: T0 + 5_000,
      deadlineAt: T0 + 35_000,
    });
    expect(diagnostics.at(-1)?.status).toBe('skipped');
    expect(player.calls.filter((call) => call.startsWith('cue:')).length).toBe(
      cuesBefore,
    );
    controller.destroy();
  });

  it('keeps a cue-time embed error terminal', async () => {
    FakeYTPlayer.cueError = 101;
    const harness = installDom();
    const { player, clock, diagnostics } = await create(harness, plan(), {
      now: T0 - 1_000,
    });

    expect(diagnostics.at(-1)?.status).toBe('skipped');
    expect(diagnostics.at(-1)?.errorCode).toBe(101);
    clock.advance(5_000);
    expect(hasCall(player, 'play')).toBe(false);
    expect(hasCall(player, 'seek:')).toBe(false);
  });

  it('re-cues and resets start evidence on a same-video clip change', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    player.state(1);
    expect(diagnostics.at(-1)?.observedStartAt).toBe(T0);

    controller.update(
      plan({ startSeconds: 20, startAt: T0 + 10_000, deadlineAt: T0 + 40_000 }),
    );
    expect(hasCall(player, `cue:${VIDEO_ID}:20:50`)).toBe(true);
    expect(diagnostics.at(-1)?.observedStartAt).toBeNull();

    const playsAfter = player.calls.filter((call) => call === 'play').length;
    clock.advance(10_000);
    expect(player.calls.filter((call) => call === 'play')).toHaveLength(
      playsAfter + 1,
    );
    controller.destroy();
  });

  it('clamps and applies local volume and mute', async () => {
    const harness = installDom();
    const { controller, player } = await create(harness, plan(), {
      now: T0,
      volume: 150,
    });

    expect(player.volume).toBe(100);
    controller.setVolume(-5);
    expect(player.volume).toBe(0);
    controller.setMuted(true);
    expect(player.muted).toBe(true);
    controller.setMuted(false);
    expect(player.muted).toBe(false);
    controller.destroy();
  });

  it('clears every timer and callback on destroy', async () => {
    const harness = installDom();
    const { controller, player, clock, diagnostics } = await create(
      harness,
      plan(),
      { now: T0 },
    );

    clock.advance(0);
    player.state(1);
    controller.destroy();
    expect(player.destroyed).toBe(true);
    expect(harness.iframes[0].isConnected).toBe(false);

    const frozen = diagnostics.length;
    clock.advance(5_000);
    player.state(1);
    player.error(100);
    expect(diagnostics).toHaveLength(frozen);
  });

  it('rejects an abort before the player is ready', async () => {
    const harness = installDom();
    const controller = new AbortController();
    const pending = createPlayback(
      harness.container as unknown as HTMLElement,
      {
        plan: plan(),
        title: 'Playback',
        serverNow: () => T0,
        onDiagnostics: () => undefined,
        signal: controller.signal,
      },
    );
    controller.abort();
    // Let the API singleton settle so the pending loader timer is cleared;
    // the abort has already won the race and no player may be constructed.
    harness.windowStub.YT = { Player: FakeYTPlayer };
    harness.windowStub.onYouTubeIframeAPIReady?.();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(harness.iframes).toHaveLength(0);
    expect(FakeYTPlayer.instances).toHaveLength(0);
  });

  it('rejects an invalid plan before touching the API', async () => {
    const harness = installDom();
    await expect(
      createPlayback(harness.container as unknown as HTMLElement, {
        plan: plan({ videoId: 'too-short' }),
        title: 'Playback',
        serverNow: () => T0,
        onDiagnostics: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(harness.scripts).toHaveLength(0);
  });
});
