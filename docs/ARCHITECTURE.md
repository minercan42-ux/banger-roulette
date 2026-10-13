# Architecture

## Implemented in M0

Vite/React strict TypeScript shell, Tailwind styles, Zustand language selection and i18next DE/EN resources. No service is contacted; no game state is persisted. `src/main.tsx` integrates `src/ui/Shell.tsx`. `src/content/genres.json` defines fifty stable bilingual genres. `src/shared/` holds strict Zod primitives, separate defaulted local/required wire settings, GameState/phase/result schemas, commands and network envelopes. UI engine access is restricted to the public `src/engine/selectors.ts` entry when M1 creates it; other engine imports fail lint. Engine net/player/UI dependencies fail lint, including extensionless TypeScript imports.

## Contract invariants

- Settings defaults apply only to local input. Wire settings require every field.
- `rouletteGenrePool` retains the injected 30–50-genre catalogue on every complete snapshot. Active `genrePool` derives from settings: catalogue for roulette, custom items for custom, one fixed genre for fixed. Constructor argument `genrePool` supplies the source catalogue even for a fixed/custom start; switching modes back to roulette restores it, without a module cache or static fallback.
- `roomId` identifies a session; the human room code is not a reservation or authority proof. Only discovery STATE_REQUEST may have null roomId.
- `stateVersion` orders complete snapshots; hostEpoch and hostBaseVersion identify migration lineage. Sender/connection/epoch authority additionally requires M2 adapter context, not just schema validity.
- Unique IDs, record identity, participants, owners, song references, own-vote/flag exclusion, HTTPS i.ytimg.com thumbnails, bounded media/clips and deadlines are validated before state acceptance.
- Zero/one-song results require zero player and owner deltas, no Borda, bonus or genre-fail penalty; empty song arrays do not bypass validation.
- Commands carry gameNumber/roundNumber to reject stale same-phase commands. Engine time and nonzero uint32 RNG seed are injected. Orthogonal pause preserves phase; accepted submissions/ballots/flags survive departure.
- No parallel PLAY_EVENT: authoritative playback is solely phase index/startAt/deadlineAt plus round playbackOrder/media in a complete snapshot.
- SNAPSHOT_ACK is one designated replica's schema-accepted receipt, not server ACK or persistence. Snapshot parts are transport frames only; M2 must reassemble atomically and validate the complete event.
- Election and designated-replica ties use locale-independent code-unit clientId ordering after joinedAt. Election prefers players over spectators; replica ACK selection deliberately does not.

## Pure engine and public UI boundary

The M1 kernel is in `src/engine/`. Host/Net integration uses `index.ts`; UI imports only `selectors.ts`. The shell does not dispatch gameplay yet.

| API                                                                      | Contract                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createInitialState`                                                     | Inject valid room/player IDs, the full catalogue, complete settings, integer normalized server time and a nonzero uint32 seed. Invalid constructor inputs are rejected, not silently normalized.                                                                                                                 |
| `reducer(state, action)`                                                 | Consume schema-valid state/actions; re-check business phase, actor, binding and stale-scope guards. Preserve input data; invalid/no-op returns the same reference. A due deadline is processed before dropping a late command.                                                                                   |
| `classifyCommand`                                                        | Pure protocol rejection reason or null. Fresh unchanged input is `NOT_READY`; cached replay is accepted without applying twice. Adapter uses classification/cache, not a version delta alone. Rate limiting belongs to M2, not this classifier.                                                                  |
| `selectViewerPermissions`, `selectEligibleSongs`, `selectFlaggableSongs` | Require `(state, viewerId, viewerConnectionId)`. Missing, stale or unbound connection has no writes; finished voting closes ranking and flags. Playback flags are set-once, voting flags retractable until finish.                                                                                               |
| Presentation / choices                                                   | ID-only presentation reads remain available to stale/read-only tabs. Before reveal, current owners/submission mapping and other ballots are absent; linked status/count stays public for the unnamed animation. Own choices stay readable. Revealed history and dense shared standings include departed players. |
| `selectSettings`, `selectGenrePool`                                      | Copy safe lobby settings/active-pool views. UI edits remain local drafts until an action; returned data must not mutate the authoritative state.                                                                                                                                                                 |

Every permanent engine test uses deterministic injected inputs. Coverage excludes `src/engine/fixtures.ts` (test-only helpers) and retains the 90% production-engine line threshold. M1 verifies pure transitions and scoring, not live transport failover or YouTube synchronization.

## Planned playback synchronization (M2/M4, not implemented)

```mermaid
sequenceDiagram
  participant H as Browser host
  participant T as Same-origin /api/time
  participant R as Supabase room
  participant C as Client browser
  participant Y as Local YouTube player
  H->>T: GET time samples
  T-->>H: serverNow, no-store
  C->>T: GET time samples
  T-->>C: serverNow, no-store
  H->>R: Complete SNAPSHOT with media, startAt, deadlineAt
  R-->>C: Validated snapshot
  C->>Y: Prebuffer clip after embedding consent
  C->>Y: play at normalized startAt
  C->>Y: Local seek if drift exceeds 750 ms
```

The API/player/transport paths above are future milestones. Advertisements, cold seeks, buffering, autoplay policies and browser scheduling can prevent the ±500ms target. Presence timeout/partitions can prevent five-second migration; measure AK goals, never represent them as API guarantees. See ADR-001 and SECURITY.md.
