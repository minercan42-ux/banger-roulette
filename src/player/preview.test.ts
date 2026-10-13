import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewStatus } from './preview';
import type * as PreviewModule from './preview';

let createPreview: typeof PreviewModule.createPreview;
let PreviewError: typeof PreviewModule.PreviewError;

const VIDEO_ID = 'M7lc1UVf-VE';

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
  target: FakePlayer;
  data?: number;
}

interface FakeEvents {
  onReady?: (event: FakeEvent) => void;
  onStateChange?: (event: FakeEvent) => void;
  onError?: (event: FakeEvent) => void;
  onAutoplayBlocked?: (event: FakeEvent) => void;
}

class FakePlayer {
  static instances: FakePlayer[] = [];
  static initializationError: 'before' | 'after' | null = null;
  readonly calls: string[] = [];
  duration = 0;
  current = 0;
  videoId = VIDEO_ID;
  destroyed = false;
  readonly events: FakeEvents;

  constructor(
    private readonly iframe: FakeIframe,
    options: { events: FakeEvents },
  ) {
    this.events = options.events;
    FakePlayer.instances.push(this);
    if (FakePlayer.initializationError === 'before') {
      this.events.onError?.({ target: this, data: 101 });
    }
    this.events.onReady?.({ target: this });
    if (FakePlayer.initializationError === 'after') {
      this.events.onError?.({ target: this, data: 101 });
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

  destroy(): void {
    this.destroyed = true;
    this.iframe.isConnected = false;
  }
}

interface Harness {
  windowStub: {
    YT?: { Player: typeof FakePlayer };
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

function start(harness: Harness, statuses: PreviewStatus[], startSeconds = 0) {
  const pending = createPreview(harness.container as unknown as HTMLElement, {
    videoId: VIDEO_ID,
    startSeconds,
    title: 'Preview',
    onStatus: (status) => statuses.push(status),
  });
  harness.windowStub.YT = { Player: FakePlayer };
  harness.windowStub.onYouTubeIframeAPIReady?.();
  return pending;
}

beforeEach(async () => {
  FakePlayer.instances = [];
  FakePlayer.initializationError = null;
  vi.resetModules();
  // Loader-boundary tests require a fresh singleton; static imports retain it.
  ({ createPreview, PreviewError } = await import('./preview'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createPreview', () => {
  it('loads the API once and emits ready then playing with the real duration', async () => {
    const harness = installDom();
    const statuses: PreviewStatus[] = [];
    const preview = await start(harness, statuses, 42);

    expect(harness.scripts).toHaveLength(1);
    expect(statuses).toEqual([{ type: 'ready' }]);

    const player = FakePlayer.instances[0];
    player.duration = 212.4;
    player.events.onStateChange?.({ target: player, data: 1 });
    expect(statuses).toContainEqual({
      type: 'playing',
      durationSeconds: 212.4,
    });

    preview.destroy();
    expect(player.destroyed).toBe(true);
    expect(harness.iframes[0].isConnected).toBe(false);
  });

  it('injects the shared API script only once', async () => {
    const harness = installDom();
    await start(harness, []);
    await start(harness, []);
    expect(harness.scripts).toHaveLength(1);
    expect(harness.iframes).toHaveLength(2);
  });

  it('surfaces error codes and autoplay blocking transparently', async () => {
    const harness = installDom();
    const statuses: PreviewStatus[] = [];
    await start(harness, statuses);
    const player = FakePlayer.instances[0];

    player.events.onError?.({ target: player, data: 101 });
    player.events.onAutoplayBlocked?.({ target: player });
    expect(statuses).toContainEqual({ type: 'error', code: 101 });
    expect(statuses).toContainEqual({ type: 'autoplayBlocked' });
  });

  it('suppresses every callback after destroy', async () => {
    const harness = installDom();
    const statuses: PreviewStatus[] = [];
    const preview = await start(harness, statuses);
    const player = FakePlayer.instances[0];

    preview.destroy();
    const before = statuses.length;
    player.events.onStateChange?.({ target: player, data: 1 });
    player.events.onError?.({ target: player, data: 100 });
    player.events.onAutoplayBlocked?.({ target: player });
    expect(statuses).toHaveLength(before);
  });

  it('destroys a pending preview on abort without creating an iframe', async () => {
    const harness = installDom();
    const controller = new AbortController();
    const pending = createPreview(harness.container as unknown as HTMLElement, {
      videoId: VIDEO_ID,
      startSeconds: 0,
      title: 'Preview',
      onStatus: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    harness.windowStub.YT = { Player: FakePlayer };
    harness.windowStub.onYouTubeIframeAPIReady?.();

    await expect(pending).rejects.toBeInstanceOf(PreviewError);
    expect(harness.iframes).toHaveLength(0);
    expect(FakePlayer.instances).toHaveLength(0);
  });

  it('surfaces a script load timeout and cleans up', async () => {
    vi.useFakeTimers();
    const harness = installDom();
    const pending = createPreview(harness.container as unknown as HTMLElement, {
      videoId: VIDEO_ID,
      startSeconds: 0,
      title: 'Preview',
      onStatus: () => undefined,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(PreviewError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(harness.iframes).toHaveLength(0);
    const statuses: PreviewStatus[] = [];
    const recovered = await start(harness, statuses);
    expect(statuses).toEqual([{ type: 'ready' }]);
    expect(FakePlayer.instances).toHaveLength(1);
    recovered.destroy();
  });

  it.each(['before', 'after'] as const)(
    'preserves an embedding error %s the ready callback',
    async (order) => {
      FakePlayer.initializationError = order;
      const statuses: PreviewStatus[] = [];
      const preview = await start(installDom(), statuses);
      expect(statuses).toEqual([{ type: 'error', code: 101 }]);
      preview.destroy();
    },
  );

  it('rejects a different video navigated within the same player', async () => {
    const statuses: PreviewStatus[] = [];
    const preview = await start(installDom(), statuses);
    const player = FakePlayer.instances[0];
    player.duration = 200;
    player.events.onStateChange?.({ target: player, data: 1 });
    expect(statuses.at(-1)).toEqual({ type: 'playing', durationSeconds: 200 });
    player.videoId = 'dQw4w9WgXcQ';
    player.duration = 500;
    player.events.onStateChange?.({ target: player, data: 1 });
    expect(statuses.at(-1)).toEqual({ type: 'error', code: 0 });
    preview.destroy();
  });
});
