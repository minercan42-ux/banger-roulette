# ADR-002: Connection-bound session authority and snapshot progress timeout

Status: accepted for M2. User authorized continuation after M0/M1 and explicitly selected the five-second **inactivity**, not total-transfer, timeout.

## Context

A complete snapshot is the recovery boundary for the browser-hosted game. Stored `connected` flags can lag Presence. Updating Presence through the reducer before migration would increment the adopted snapshot version and break `hostBaseVersion = adoptedVersion`. Rebinding the current host to a second tab also makes an ordinary snapshot from the old connection invalid: the snapshot's new host binding and its old sender connection differ.

At the Supabase Free 100-message/second project limit, sending 128 × 48 KiB parts to ten clients cannot meet a five-second total-transfer deadline. Retained departed identities are not bounded by the ten-active-player limit; large states must not be silently capped below the existing 128-part/6-MiB codec contract.

## Decision

1. `electHost(state, connectionIds)` and `HOST_CHANGED.connectionIds` require the authoritative full Presence list. Election ignores stale connected flags, excludes left/kicked identities, prefers players, and breaks ties by joinedAt/code-unit clientId. Apply `HOST_CHANGED` to the unmodified highest complete old snapshot, producing `base + 1`; only the new host subsequently applies Presence changes.
2. Explicit `HOST_HANDOFF { recipientId, baseVersion, state }` transfers the same host identity to its newest accepted tab. The confirmed old host connection sends the state at `baseVersion + 1`, with the same room and epoch but a new host connection binding. Receivers validate against their old host binding before adopting. The new bound tab publishes ordinary snapshots; the old tab becomes read-only. No spoofed envelope connection, epoch bump or out-of-migration replica alias.
3. Chunk reassembly expires five seconds after the last **new valid unique part**. Identical duplicates do not extend the timer; conflicting parts discard the entire transfer. Preserve 48-KiB UTF-8 pieces, at most 128 parts/6 MiB, one current assembly per authorized sender, and atomic complete-event schema validation. Large transfers can exceed five seconds total.
4. Distinct real state versions are published in order, never coalesced. Redundant discovery/resync requests for the same version may share one pending full snapshot. Sender pacing accounts for room fanout; other rooms, commands, results and ACKs still consume the same project quota. This is not a global quota guarantee.
5. `/api/time` exports a GET Web Handler returning uncached server milliseconds. Local Vite invokes the same handler; production runs it as a Vercel Node function. Browser clocks use several RTT midpoint samples and a median offset; a failed synchronization is explicit, not fabricated.

## Consequences and limits

No authentication, persistent game state or partition-consensus guarantee is added. Both migration and tab handoff retain accepted round data. Replica ACK means schema-accepted receipt by one designated client, not durable storage. Sound consent in M2 unlocks Web Audio; YouTube autoplay remains separately validated in M3/M4. The snapshot timeout change does **not** relax AK-4/AK-5's five-second migration/rejoin goals or AK-7's playback target.

Sources: [Supabase Presence](https://supabase.com/docs/guides/realtime/presence), [Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [Realtime limits](https://supabase.com/docs/guides/realtime/limits), [heartbeat behavior](https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages), [Vercel Functions Web Handler API](https://vercel.com/docs/functions/functions-api-reference).
