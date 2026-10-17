# Product

<!-- impeccable:product-schema 1 -->

Provenance: statements marked **(owner)** were given by the owner (@minercan42-ux) on 2026-10-17 and are confirmed. Statements marked **(repo)** come from SPEC.md, README.md or docs/ and are repository evidence, not owner statements. Where the two differ, SPEC.md wins (AGENTS.md).

## Platform

web

## Users

- **(owner)** Primary users are groups of 3-10 friends playing remotely, each on their own device (phone or PC), typically alongside a voice or video call.
- **(owner)** Desktop first (owner decision 2026-10-17, confirms SPEC.md section 2): the desktop browser is the primary target; the layout stays responsive and playable down to 360 px width, but phone is not the primary target.
- **(repo)** A room holds 3-10 players; the host is one of them. Players joining a running game start as spectators and play from the next round (FR-05).

## Product Purpose

- **(owner)** A music-taste battle. Everyone brings their banger for the drawn genre, all listen synchronized, rate anonymously (0-10 while the song plays), then the reveal with its show. The fun is exposing and celebrating each other's taste.
- **(owner)** This core must not be diluted.
- **(repo)** Round flow: `LOBBY -> GENRE_SPIN -> SUBMISSION -> PLAYBACK -> REVEAL -> next round or FINAL -> LOBBY (rematch)` (SPEC.md section 4). Songs are YouTube links with a chosen start point and a configurable clip length (FR-20..FR-24).
- **(repo)** Success is not defined by metrics anywhere in the repository; the only quantified targets are technical (clip sync within +-500 ms, AK-7; Lighthouse and bundle budgets, NFR-01). No engagement, retention or growth goals exist, and none should be assumed.

## Positioning

- **(repo)** Mechanism: players choose the song themselves for a drawn genre, the group hears it in sync on separate devices, the vote is anonymous during playback and owners are revealed afterwards with a show, so taste is exposed and judged by friends. Scoring is the mean rating, with a round-winner bonus, a genre-fail penalty and a "Spiritually Linked" case when several players pick the same video (FR-26, FR-50..FR-52).
- **(repo)** No login, no accounts, no persistence beyond the running session (SPEC.md section 2).

## Operating Context

- **(owner)** Players are typically in a voice or video call while playing, each on their own device.
- **(repo)** Rooms are joined by a six-character code or the link `/r/{CODE}`; the game runs host-authoritatively in the host's browser with Supabase Realtime as transport and Vercel for the static app and two small functions (`/api/time`, `/api/oembed`). See docs/ARCHITECTURE.md and docs/ADR-001-realtime.md.
- **(repo)** Audio autoplay is gated by the browser. A start popup ("Los geht's") unlocks sound and grants the YouTube embedding consent in one click; "Ohne Videos" unlocks audio only and loads nothing from YouTube (NFR-04).
- **(repo)** German and English UI, language picked from the browser, switchable, fallback German (SPEC.md section 2).

## Capabilities and Constraints

- **(repo)** Host settings in the lobby: genre mode (roulette, custom list, single genre), rounds, selection time, clip length, anonymity, genre-fail penalty, linked-points rule (SPEC.md section 5.2).
- **(repo)** Genre roulette with a host-determined result so every client animates to the same segment (FR-10, FR-11); song submission with embed validation (FR-22); synchronized playback with clock offset and drift correction (FR-31, FR-32); live 0-10 rating (FR-40); reveal with leaderboard, finale and rematch (FR-60..FR-62).
- **(repo)** Anonymity is enforced in the UI only; every client receives the full state and DevTools can circumvent it. This is an accepted MVP limit for a circle of friends (docs/SECURITY.md, SPEC.md section 3). Design and copy must not promise cryptographic anonymity.
- **(repo)** Free-tier cost frame (Vercel Hobby, Supabase Free); initial JS under 250 kB gzip; Lighthouse Performance desktop >= 90 and mobile >= 80 (NFR-01, NFR-02).
- **(repo)** Non-goals for the MVP: accounts, persistence, cross-game leaderboards, Spotify, in-app YouTube search, public matchmaking, chat, moderation, monetization (SPEC.md section 8).
- **(repo)** Terminology used in code and copy: Banger, Genre-Fail, Spiritually Linked, Reveal, Finale, Rematch, Host.
- Undecided: whether a public version (phase 2) is built; docs/ROADMAP.md only lists phase 2 items as candidates and no owner decision is recorded.

## Brand Commitments

- **(owner)** The Pixel-Filz casino look is binding. docs/design/pixel-filz/ is the design system: red felt, anthracite panels, Spieltisch (game table) layout.
- **(owner)** No accounts and no tracking. Only the random player ID, the YouTube consent and the volume/mute/SFX preferences are stored.
- **(repo)** Tone and voice rules live in docs/design/pixel-filz/README.md (informal "du", short, cheeky, never mean; error texts factual). SPEC.md section 6 forbids unlicensed copyrighted assets and third-party logos. The fonts (Jersey 10, Silkscreen) are SIL OFL 1.1 and ship with their licenses.
- **(repo)** The Pixel-Filz directory is labeled a plan in its own README; implemented parts in `src/ui/` follow it. Agents implement from it only on an assigned task issue (AGENTS.md rule 7).

## Evidence on Hand

- **(repo)** SPEC.md, README.md, docs/ARCHITECTURE.md, docs/SECURITY.md, docs/OPEN_QUESTIONS.md, docs/ROADMAP.md, docs/ADR-001-realtime.md, docs/ADR-002-session-authority.md, and the design system in docs/design/pixel-filz/ (tokens, components, gallery).
- **(repo)** A running production deployment at https://banger-roulette.vercel.app/ and an automated E2E suite over in-memory multi-client rooms (README.md).
- **(repo)** Not on hand, so future work must not invent them: user research, playtest results, player counts, testimonials, press, benchmarks, pricing, a legal imprint or privacy policy (listed as phase 2 in SPEC.md section 8), or a logo or brand assets beyond what is in the repository.

## Product Principles

1. **The song and the taste are the content.** Every screen serves choosing, hearing, rating or revealing songs; chrome, decoration and motion never compete with the music or bury the genre and song information.
2. **Anonymity is protected until the reveal.** With anonymity on (the default), no element before the reveal may disclose who owns a song (AK-3); the reveal is the payoff and is staged as one.
3. **Everyone hears the same moment.** Synchronized playback and shared timers drive the design: players should trust that the others are hearing the same thing now, and failures (ads, buffering, blocked playback) degrade without stalling the group.
4. **Zero friction to join, nothing kept.** No accounts, no tracking; join by link, one click to start. Only the random player ID, the YouTube consent and the volume/mute/SFX preferences are stored, and consent stays revocable.
5. **Built for friends on a call.** Rounds are quick (SPEC.md: fast rounds), and the fun comes from timing and tone between friends, not from explanations.

## Accessibility & Inclusion

- **(repo)** Full keyboard operation, WCAG AA contrast, `aria-live` announcements for phase changes and timers, `prefers-reduced-motion` respected, 360 px layout (SPEC.md section 6, README.md).
- **(repo)** German and English are both first-class; no hardcoded UI strings (DE and EN keys, `pnpm i18n:check`).
- **(repo)** A known Firefox issue keeps the submission preview iframe in the tab order (issue #57). No further product-specific accessibility needs were established by the owner.
