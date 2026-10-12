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
