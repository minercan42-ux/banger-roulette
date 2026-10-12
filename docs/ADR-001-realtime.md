# ADR-001: Supabase Realtime for room coordination

Status: accepted with the M0/M1 plan.

## Decision

Use one public Supabase Realtime channel per room code, Broadcast for complete versioned snapshots and commands, Presence for connection discovery. No tables, authentication, or service-role credentials. The browser host runs the deterministic engine.

## Evidence

[Vercel WebSockets documentation](https://vercel.com/docs/functions/websockets), checked during M0, confirms Beta on all plans. A connection is pinned to one Function instance; new connections can reach different instances. Bun publish/subscriptions are instance-local. Shared rooms, Presence and pub/sub coordination require an external store. Native WebSocket availability alone does not provide the specified room coordination. [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast) and [Presence](https://supabase.com/docs/guides/realtime/presence) supply those services.

## Consequences

Broadcast acknowledgements are not durable persistence or proof that every client received a snapshot. Presence and browser timers do not guarantee five-second failover. AK-4/5 remain measured M2 goals. M0 defines envelopes, host epochs and replica acknowledgements; it does not implement transport. See SECURITY.md for the accepted unauthenticated trust boundary.
