import type { NetClock } from './clock';
import { NetworkEventSchema, type NetworkEvent } from '../shared/protocol';

/**
 * Transport limits from the approved plan (plan rule 13). The 128-part / 6 MiB
 * cap is a codec serialization and reassembly bound, not a quota guarantee.
 * The reassembly TTL is 5 s since the last new unique part (identical
 * duplicates do not extend it), so a paced transfer whose inter-part gaps stay
 * under 5 s completes even when its total duration exceeds 5 s; the sender's
 * fanout pacing keeps those gaps far below the TTL.
 */
export const DIRECT_BYTES = 192 * 1024;
export const PART_BYTES = 48 * 1024;
export const MAX_PARTS = 128;
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const PART_EXPIRY_MS = 5000;

export interface ChunkLimits {
  directBytes: number;
  partBytes: number;
  maxParts: number;
  expiryMs: number;
  /** Concurrent in-flight transfers kept per sender (default one). */
  maxAssembliesPerSender?: number;
  /** Hard cap on concurrent transfers across all senders. */
  maxAssemblies?: number;
  /** Hard cap on decoded bytes retained across all transfers. */
  maxAggregateBytes?: number;
}

export const MAX_ASSEMBLIES_PER_SENDER = 1;
export const MAX_ASSEMBLIES = 10;
export const MAX_AGGREGATE_BYTES = 12 * 1024 * 1024;

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = {
  directBytes: DIRECT_BYTES,
  partBytes: PART_BYTES,
  maxParts: MAX_PARTS,
  expiryMs: PART_EXPIRY_MS,
  maxAssembliesPerSender: MAX_ASSEMBLIES_PER_SENDER,
  maxAssemblies: MAX_ASSEMBLIES,
  maxAggregateBytes: MAX_AGGREGATE_BYTES,
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

/**
 * Encodes a full-state event as either one direct frame or a set of
 * `SNAPSHOT_PART` frames. Only bodies that carry a whole `GameState`
 * (`SNAPSHOT`, `REPLICA_SNAPSHOT`, `HOST_HANDOFF`) are chunked; every other
 * body is small enough to send as-is.
 */
export function encodeEvent(
  event: NetworkEvent,
  limits: ChunkLimits,
  transferId: string,
): NetworkEvent[] {
  const body = event.body;
  if (
    body.type !== 'SNAPSHOT' &&
    body.type !== 'REPLICA_SNAPSHOT' &&
    body.type !== 'HOST_HANDOFF'
  ) {
    return [event];
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.length <= limits.directBytes) {
    return [event];
  }
  const total = Math.ceil(bytes.length / limits.partBytes);
  if (total > limits.maxParts || bytes.length > MAX_TOTAL_BYTES) {
    throw new ChunkError('Snapshot exceeds the transport budget');
  }
  const frames: NetworkEvent[] = [];
  for (let index = 0; index < total; index += 1) {
    const slice = bytes.subarray(
      index * limits.partBytes,
      (index + 1) * limits.partBytes,
    );
    frames.push({
      ...event,
      body: {
        type: 'SNAPSHOT_PART',
        transferId,
        stateVersion: body.state.stateVersion,
        index,
        total,
        dataBase64: bytesToBase64(slice),
      },
    });
  }
  return frames;
}

interface Assembly {
  roomCode: string;
  roomId: string;
  senderId: string;
  connectionId: string;
  hostEpoch: number;
  sentAt: number;
  stateVersion: number;
  total: number;
  bytes: number;
  parts: Map<number, Uint8Array>;
  timer: number;
}

export interface ReassemblerHooks {
  onComplete(event: NetworkEvent): void;
  onFailure(): void;
}

/**
 * Reassembles chunked snapshots atomically. A single in-flight transfer per
 * sender is kept; wrong, conflicting, oversized, expired or incomplete sets are
 * discarded whole and never applied partially.
 */
export class Reassembler {
  private readonly assemblies = new Map<string, Assembly>();
  private readonly maxAssembliesPerSender: number;
  private readonly maxAssemblies: number;
  private readonly maxAggregateBytes: number;

  constructor(
    private readonly clock: NetClock,
    private readonly limits: ChunkLimits,
  ) {
    this.maxAssembliesPerSender =
      limits.maxAssembliesPerSender ?? MAX_ASSEMBLIES_PER_SENDER;
    this.maxAssemblies = limits.maxAssemblies ?? MAX_ASSEMBLIES;
    this.maxAggregateBytes = limits.maxAggregateBytes ?? MAX_AGGREGATE_BYTES;
  }

  feed(event: NetworkEvent, hooks: ReassemblerHooks): void {
    const body = event.body;
    if (body.type !== 'SNAPSHOT_PART') {
      return;
    }
    const key = `${event.senderId}:${body.transferId}`;
    let assembly = this.assemblies.get(key);
    if (assembly === undefined) {
      if (!this.hasCapacity(event.senderId)) {
        return;
      }
      assembly = {
        roomCode: event.roomCode,
        roomId: event.roomId ?? '',
        senderId: event.senderId,
        connectionId: event.connectionId,
        hostEpoch: event.hostEpoch,
        sentAt: event.sentAt,
        stateVersion: body.stateVersion,
        total: body.total,
        bytes: 0,
        parts: new Map(),
        timer: 0,
      };
      this.armExpiry(key, assembly, hooks);
      this.assemblies.set(key, assembly);
    } else if (!sameTransfer(assembly, event, body)) {
      this.discard(key, assembly);
      hooks.onFailure();
      return;
    }

    const existing = assembly.parts.get(body.index);
    const decoded = base64ToBytes(body.dataBase64);
    if (existing !== undefined) {
      if (existing.length === decoded.length && sameBytes(existing, decoded)) {
        return;
      }
      this.discard(key, assembly);
      hooks.onFailure();
      return;
    }
    assembly.bytes += decoded.length;
    if (
      assembly.bytes > MAX_TOTAL_BYTES ||
      this.totalBytes() > this.maxAggregateBytes
    ) {
      this.discard(key, assembly);
      hooks.onFailure();
      return;
    }
    assembly.parts.set(body.index, decoded);
    // Real progress: the expiry is 5 s since the last new unique part, so a
    // paced transfer may take longer than 5 s overall. Identical duplicates
    // never reach here, so they cannot extend the window.
    this.armExpiry(key, assembly, hooks);
    if (assembly.parts.size !== assembly.total) {
      return;
    }

    const ordered: Uint8Array[] = [];
    for (let index = 0; index < assembly.total; index += 1) {
      const part = assembly.parts.get(index);
      if (part === undefined) {
        this.discard(key, assembly);
        hooks.onFailure();
        return;
      }
      ordered.push(part);
    }
    this.discard(key, assembly);

    let parsedBody: unknown;
    try {
      const joined = new Uint8Array(assembly.bytes);
      let offset = 0;
      for (const part of ordered) {
        joined.set(part, offset);
        offset += part.length;
      }
      parsedBody = JSON.parse(new TextDecoder().decode(joined));
    } catch {
      hooks.onFailure();
      return;
    }

    const rebuilt = NetworkEventSchema.safeParse({
      protocolVersion: 1,
      roomCode: assembly.roomCode,
      roomId: assembly.roomId,
      senderId: assembly.senderId,
      connectionId: assembly.connectionId,
      hostEpoch: assembly.hostEpoch,
      sentAt: assembly.sentAt,
      body: parsedBody,
    });
    if (!rebuilt.success) {
      hooks.onFailure();
      return;
    }
    hooks.onComplete(rebuilt.data);
  }

  /** Number of in-flight transfers; test seam for the memory bounds. */
  count(): number {
    return this.assemblies.size;
  }

  /** Drops every in-flight transfer; used on disconnect. */
  reset(): void {
    for (const [key, assembly] of this.assemblies) {
      this.discard(key, assembly);
    }
  }

  private hasCapacity(senderId: string): boolean {
    if (this.assemblies.size >= this.maxAssemblies) {
      return false;
    }
    let forSender = 0;
    for (const assembly of this.assemblies.values()) {
      if (assembly.senderId === senderId) {
        forSender += 1;
      }
    }
    return forSender < this.maxAssembliesPerSender;
  }

  private totalBytes(): number {
    let total = 0;
    for (const assembly of this.assemblies.values()) {
      total += assembly.bytes;
    }
    return total;
  }

  private discard(key: string, assembly: Assembly): void {
    this.clock.clearTimeout(assembly.timer);
    this.assemblies.delete(key);
  }

  private armExpiry(
    key: string,
    assembly: Assembly,
    hooks: ReassemblerHooks,
  ): void {
    this.clock.clearTimeout(assembly.timer);
    assembly.timer = this.clock.setTimeout(() => {
      this.assemblies.delete(key);
      hooks.onFailure();
    }, this.limits.expiryMs);
  }
}

function sameTransfer(
  assembly: Assembly,
  event: NetworkEvent,
  body: Extract<NetworkEvent['body'], { type: 'SNAPSHOT_PART' }>,
): boolean {
  return (
    assembly.roomCode === event.roomCode &&
    assembly.roomId === event.roomId &&
    assembly.senderId === event.senderId &&
    assembly.connectionId === event.connectionId &&
    assembly.hostEpoch === event.hostEpoch &&
    assembly.stateVersion === body.stateVersion &&
    assembly.total === body.total
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}
