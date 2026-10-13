import type { Genre } from '../shared/primitives';
import type { Settings } from '../shared/settings';
import type { ChunkLimits } from './chunk';
import type { NetClock } from './clock';
import type { InMemoryHub } from './inMemory';
import { createGameSession, type GameSession } from './session';

/**
 * Test-only helpers. Never imported by the app; the engine keeps its own
 * `fixtures.ts` for the same reason. Exposes the injectable seams so tests and
 * the cross-context browser harness can drive the real transport contract.
 */

/** Fully controllable clock: `advance` runs every timer that becomes due. */
export class ManualClock implements NetClock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; handler: () => void }
  >();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(handler: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + Math.max(0, ms), handler });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let dueId = 0;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (
          timer.at <= target &&
          (timer.at < dueAt || (timer.at === dueAt && id < dueId))
        ) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      const due = this.timers.get(dueId);
      if (dueId === 0 || due === undefined) {
        break;
      }
      this.timers.delete(dueId);
      this.time = Math.max(this.time, due.at);
      due.handler();
    }
    this.time = target;
  }
}

/** Deterministic RFC-4122 v4-shaped UUIDs for reproducible tests. */
export function uuidFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, '0')}`;
  };
}

/** Thirty unique roulette genres, matching the catalogue contract. */
export function testCatalogue(): Genre[] {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `g${index}`,
    de: `Genre ${index}`,
    en: `Genre ${index}`,
  }));
}

export interface TestSessionConfig {
  hub: InMemoryHub;
  clock: NetClock;
  clientId: string;
  connectionId: string;
  uuid: () => string;
  fetchServerTime?: () => Promise<number>;
  genreCatalogue?: Genre[];
  settings?: Settings;
  rateLimit?: { burst: number; perSecond: number };
  chunkLimits?: Partial<ChunkLimits>;
  commandTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  migrationCollectMs?: number;
}

export function createTestSession(config: TestSessionConfig): GameSession {
  return createGameSession({
    clientId: config.clientId,
    connectionId: config.connectionId,
    transport: config.hub,
    clock: config.clock,
    fetchServerTime: config.fetchServerTime ?? (async () => config.clock.now()),
    genreCatalogue: config.genreCatalogue ?? testCatalogue(),
    uuid: config.uuid,
    settings: config.settings,
    rateLimit: config.rateLimit,
    chunkLimits: config.chunkLimits,
    commandTimeoutMs: config.commandTimeoutMs,
    discoveryTimeoutMs: config.discoveryTimeoutMs,
    migrationCollectMs: config.migrationCollectMs,
  });
}

/** Lets every queued microtask (promise continuations) run. */
export async function flush(times = 24): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Drives the real paced sender: advances the injected clock (refilling its
 * token bucket) and then lets every queued microtask run. Tests use this in
 * place of `flush` wherever an operation emits frames, so production timers
 * are exercised rather than bypassed.
 */
export async function settle(clock: ManualClock, ms = 500): Promise<void> {
  clock.advance(ms);
  await flush();
}
