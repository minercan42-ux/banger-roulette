# Approved defaults and outstanding gates

The section-13 M0/M1 plan was approved. These defaults resolve specification gaps, not external API guarantees.

| Area               | Approved default                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room codes         | ABCDEFGHJKLMNPQRSTUVWXYZ; after SUBSCRIBED and Presence sync, roomId collision tie-break; no atomic reservation guarantee.                                                                                           |
| Identity           | localStorage clientId; per-tab connectionId; latest accepted JOIN binds the writable connection. Trim/NFKC/case-insensitive nickname uniqueness; reconnect keeps original identity and nickname.                     |
| Quorum             | Freeze participants at GENRE_SPIN; late joins spectate until next round. Ten connected clients including spectators. Keep accepted submissions/votes/flags after disconnect or kick.                                 |
| Pause              | Orthogonal pause; resume shifts all phase timestamps by elapsed pause. Host forceBelowMinimum survives until further disconnect or next round.                                                                       |
| Submission         | Finish irreversible within round; changing videoId receives a new acceptedOrder. First remaining duplicate submission determines media.                                                                              |
| Scoring            | Partial ranking k gives k..1. Strict majority over frozen participants minus owners. Eligible highest Borda gets +2; all ties. halfCeil = ceil((Borda+bonus)/2) + full penalty. Zero/one song: no points or penalty. |
| Timing             | Spin 3s/fixed 1s; every playback 3s pre-roll. Reveal worst to best, 2.5s/song +5s scoreboard; zero songs 5s notice. Host may advance nonpaused timed phases.                                                         |
| Validation/player  | Real preview playback; errors 2/100/101/150 block, 5/153/unknown remain unproven/environment errors. Autoplay blocked resets local sound status without blocking the round. M3/M4 implementation only.               |
| oEmbed/privacy     | M3 same-origin proxy for validated videoId; never trust supplied HTML or arbitrary URLs. nocookie is not tracking-free; require transparent embedding consent before loading YouTube.                                |
| Migration          | joinedAt/clientId election, hostEpoch, 250ms replica collection, highest complete old snapshot; no partition-consensus claim. One designated replica ACK. No ticker messages.                                        |
| Snapshot transport | M2 direct <=192KiB, otherwise 48KiB UTF8 pieces in Base64, <=128 parts/6MiB, atomic validation/reassembly, 5s timeout. No codec in engine.                                                                           |
| Rematch            | Preserve settings, gameNumber and connected clients; reset scores/results/round/command cache. Keep kicked IDs as room bans. Dense shared final ranks.                                                               |
| Tooling            | Node24, pnpm10 exact patch. TypeScript6.0.3 chosen instead of current7 because typescript-eslint8.71.2 supports <6.1; compatibility takes precedence over unsupported latest.                                        |
| CSP                | M0 connect-src is self-only because the shell has no Realtime connection. Add exact project-ref Supabase HTTPS/WSS origins in M2; no wildcard and no .env.local read.                                                |

## User-only gates

Vercel import, Preview URL, console setup and production merge require the user. Green local checks are not green hosted CI. No milestone deployment completion is claimed without observing it. AK-4/5 and AK-7 stay unchanged; failures require a separate spec/architecture decision.

## M0 release acceptance

The user explicitly approved squash-merging PR #2 before a separate Preview check. Merge commit `678022b` deployed successfully to Production. Actual `/` and `/r/ABCDEF` (including uncached reload), three isolated DE/EN/fallback browser contexts, reload-free language switching, 360px, reduced motion, empty console/error collectors and configured security headers were observed. `/api/time` stays 404, not SPA HTML. This was a one-PR gate override, not blanket approval to merge future PRs.

## Engine guard decisions

- Retain `rouletteGenrePool` in GameState. The original single active-pool contract lost the injected catalogue on fixed/custom settings and could not switch back to roulette. The constructor's `genrePool` argument is the full source catalogue; active pool is derived from settings. No wire defaults or legacy shim.
- Fresh semantically unchanged commands are rejected with `NOT_READY`, preserve reference identity and are not cached. Only genuine accepted mutations enter the 256-command window; cached replays are accepted without another mutation. This avoids accepting an uncached command that could mutate state on a later replay. The adapter must use the pure classifier/cache, not version deltas alone.
- Nicknames remain reserved across every retained identity, including left/kicked records, so reconnect can preserve the original name. Rematch may release names of pruned left identities; kicked identities/names remain until a new roomId.
- Quorum is connected current-round participants, not late-join spectators; the ten-client room cap includes spectators. Host election prefers status player, then spectator; replica ACK selection is role-agnostic. All clientId ties are code-unit lexical, not locale/ICU collation.
- Exact fractional clipSeconds are retained; playback durations use `max(1, round(clipSeconds * 1000))` integer milliseconds for deadlineAt. Positive clips always advance time, with at most millisecond quantization rather than changing chosen media metadata.
- Zero-ballot nondegenerate rounds have a Borda-0 tie: every eligible song receives the approved +2 tie bonus. A positive Borda threshold would be a separate product change.
- Ten admitted active identities is a hard cap even on reconnect. Already admitted present bindings are never evicted automatically; an active identity may rebind a tab without another slot. Inactive JOIN returns `ROOM_FULL` while full; Presence removes absent bindings first and recovers retained inactive bindings in joinedAt/code-unit order only into free slots. Overflow stays disconnected with score/drafts/identity retained until capacity frees. Left/kicked identities are not auto-restored by Presence.
- UI write hints and rank/flag target lists require the local `viewerConnectionId`, not just clientId. Stale tabs remain read-only after a real rebind while their own stored choices stay readable. A completed voter cannot edit rankings or flags.
