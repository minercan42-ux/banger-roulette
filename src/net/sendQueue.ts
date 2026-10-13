import type { NetworkEvent } from '../shared/protocol';
import type { NetClock } from './clock';
import type { SendStatus } from './transport';

export interface PacedSenderOptions {
  /**
   * Current frames-per-second ceiling for this room (fanout-aware). The bucket
   * capacity equals one second of this rate, so a burst never exceeds roughly
   * one second of the shared message budget. This bounds this room's sends
   * only; other rooms, commands, results and ACKs consume the same budget.
   */
  framesPerSecond: () => number;
  send: (event: NetworkEvent) => Promise<SendStatus>;
  onFailure: () => void;
  /**
   * Invoked whenever the queue fully drains (all frames sent) or is cleared
   * (failure/reset), so callers can retire a "batch in flight" marker. Not
   * invoked between frames of a still-active batch.
   */
  onIdle?: () => void;
}

/**
 * Serializes every outgoing frame in FIFO order through a fanout-aware token
 * bucket: whole logical transfers keep their frame order and nothing is
 * coalesced or dropped. A short burst (within one second of budget) goes out
 * immediately; once the bucket is empty the sender waits for the refill, which
 * keeps the sustained rate honest while inter-part gaps stay far below the
 * reassembly TTL.
 */
export class PacedSender {
  private readonly queue: NetworkEvent[] = [];
  private active = false;
  private tokens = 0;
  private lastRefill = 0;
  private timer = 0;

  constructor(
    private readonly clock: NetClock,
    private readonly options: PacedSenderOptions,
  ) {}

  submit(frames: NetworkEvent[]): void {
    if (frames.length === 0) {
      return;
    }
    for (const frame of frames) {
      this.queue.push(frame);
    }
    if (!this.active) {
      this.active = true;
      void this.pump();
    }
  }

  reset(): void {
    this.queue.length = 0;
    if (this.timer !== 0) {
      this.clock.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.active = false;
    this.options.onIdle?.();
  }

  private refill(): void {
    const now = this.clock.now();
    const rate = Math.max(1, this.options.framesPerSecond());
    if (this.lastRefill === 0) {
      this.tokens = rate;
      this.lastRefill = now;
      return;
    }
    this.tokens = Math.min(
      rate,
      this.tokens + ((now - this.lastRefill) / 1000) * rate,
    );
    this.lastRefill = now;
  }

  private async pump(): Promise<void> {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const frame = this.queue.shift();
      if (frame === undefined) {
        break;
      }
      this.tokens -= 1;
      const status = await this.options.send(frame);
      if (status !== 'ok') {
        this.queue.length = 0;
        this.active = false;
        this.options.onIdle?.();
        this.options.onFailure();
        return;
      }
    }
    if (this.queue.length === 0) {
      this.active = false;
      this.options.onIdle?.();
      return;
    }
    const rate = Math.max(1, this.options.framesPerSecond());
    const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / rate) * 1000));
    this.timer = this.clock.setTimeout(() => {
      this.timer = 0;
      void this.pump();
    }, waitMs);
  }
}
