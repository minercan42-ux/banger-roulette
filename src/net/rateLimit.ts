/** Default bound on distinct keys retained; eviction is oldest-first (FIFO). */
export const MAX_RATE_LIMIT_KEYS = 64;

/**
 * Per-client token bucket. A party client bursts (tapping out a 0-10 rating
 * sends one `RATE` per change) but must not be able to flood the host. Refill is
 * continuous, so there is no fixed-window edge to game.
 *
 * The key space is attacker-controlled (unsigned sender ids can be rotated),
 * so the map is hard-capped: adding a new key while full evicts the oldest
 * entry. This bounds memory across a room's lifetime and across rooms, because
 * the session also resets its limiters on teardown.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly maxKeys: number = MAX_RATE_LIMIT_KEYS,
  ) {}

  allow(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) {
          this.buckets.delete(oldest);
        }
      }
      bucket = { tokens: this.burst, at: now };
    }
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    const available = Math.min(
      this.burst,
      bucket.tokens + elapsed * this.perSecond,
    );
    if (available < 1) {
      this.buckets.set(key, { tokens: available, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: available - 1, at: now });
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }
}
