/**
 * Injectable time source. All scheduling inside `src/net` goes through this so
 * tests can drive deadlines and migration collection windows deterministically.
 * The engine never sees it: it receives absolute server-time values only.
 */
export interface NetClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * Wall-clock implementation used by the browser factory. Handles are kept in
 * a table so the public interface stays a plain numeric id across DOM and Node
 * timer implementations.
 */
export const systemClock: NetClock = (() => {
  const handles = new Map<number, unknown>();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout: (handler, ms) => {
      const id = next;
      next += 1;
      handles.set(id, setTimeout(handler, ms));
      return id;
    },
    clearTimeout: (id) => {
      const handle = handles.get(id);
      if (handle !== undefined) {
        handles.delete(id);
        clearTimeout(handle as never);
      }
    },
  };
})();

export interface ClockSyncOptions {
  /** Same-origin `/api/time` request; must resolve to a server `Date.now()`. */
  fetchServerTime: () => Promise<number>;
  /** Local wall clock used for the send/receive bracketing. */
  localNow: () => number;
  /** Number of samples; the median offset is kept. */
  samples?: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Estimates the offset between the local clock and server time with
 * `offset = serverNow - (sendWall + receiveWall) / 2` per sample, keeping the
 * median offset and RTT. It never fabricates a value: a failed sync leaves the
 * clock explicitly unsynchronized at offset 0.
 */
export class ClockSync {
  private readonly samples: number;
  private currentOffsetMs = 0;
  private currentRttMs: number | null = null;
  private synchronized = false;

  constructor(private readonly options: ClockSyncOptions) {
    this.samples = Math.max(1, options.samples ?? 5);
  }

  get offsetMs(): number {
    return this.currentOffsetMs;
  }

  get rttMs(): number | null {
    return this.currentRttMs;
  }

  get isSynchronized(): boolean {
    return this.synchronized;
  }

  /** Server-normalized local time; falls back to raw local time before sync. */
  serverNow(): number {
    return this.options.localNow() + this.currentOffsetMs;
  }

  /** Runs the sample loop; resolves `true` once at least one sample landed. */
  async sync(): Promise<boolean> {
    const offsets: number[] = [];
    const rtts: number[] = [];
    for (let index = 0; index < this.samples; index += 1) {
      const sendWall = this.options.localNow();
      let serverNow: number;
      try {
        serverNow = await this.options.fetchServerTime();
      } catch {
        continue;
      }
      const receiveWall = this.options.localNow();
      if (!Number.isFinite(serverNow)) {
        continue;
      }
      offsets.push(serverNow - (sendWall + receiveWall) / 2);
      rtts.push(Math.max(0, receiveWall - sendWall));
    }
    if (offsets.length === 0) {
      this.currentOffsetMs = 0;
      this.currentRttMs = null;
      this.synchronized = false;
      return false;
    }
    this.currentOffsetMs = Math.round(median(offsets));
    this.currentRttMs = Math.round(median(rtts));
    this.synchronized = true;
    return true;
  }

  reset(): void {
    this.currentOffsetMs = 0;
    this.currentRttMs = null;
    this.synchronized = false;
  }
}
