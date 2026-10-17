# Banger Roulette

Browser party game: each round a genre is spun on a roulette wheel, every player submits a YouTube link to their biggest banger, everyone listens to the snippets in sync, rates the others 0-10 while they play and scores points. No login, casino vibe, German and English UI.

Status: complete, playable MVP (M0–M6) in production at [banger-roulette.vercel.app](https://banger-roulette.vercel.app/): lobby, genre roulette, submission, synchronized playback, live rating, reveal, finale and rematch work end to end ([M2](https://github.com/minercan42-ux/banger-roulette/pull/4), [M3](https://github.com/minercan42-ux/banger-roulette/pull/5), [M4](https://github.com/minercan42-ux/banger-roulette/pull/6), [M5](https://github.com/minercan42-ux/banger-roulette/pull/7)). Production follows separately approved squash merges to `main`. This is not yet the `v1.0.0` release: the M7 release gate ([#28](https://github.com/minercan42-ux/banger-roulette/issues/28)) and AK-7 acceptance on one client per device ([#21](https://github.com/minercan42-ux/banger-roulette/issues/21)) are open. The remaining casino styling of the phase screens ([#22](https://github.com/minercan42-ux/banger-roulette/issues/22) to [#26](https://github.com/minercan42-ux/banger-roulette/issues/26)) is paused until the owner has decided the Pixel-Filz redesign plan ([#45](https://github.com/minercan42-ux/banger-roulette/issues/45)); Pixel-Filz is a plan, not shipped.

## Features

- Rooms of 3–10 players by link, no login; reload and tab takeover keep your identity, the host migrates when the host leaves ([M2](https://github.com/minercan42-ux/banger-roulette/pull/4)). The first create or join retries once on a transient Realtime failure ([#36](https://github.com/minercan42-ux/banger-roulette/pull/36)).
- Genre roulette (or fixed/custom genres), YouTube link submission with validated playback and a start point ([M3](https://github.com/minercan42-ux/banger-roulette/pull/5)), clock-synchronized playback with drift correction and a `?debug=1` overlay ([M4](https://github.com/minercan42-ux/banger-roulette/pull/6)).
- Live 0-10 rating during playback, anonymous reveal with a leaderboard, genre-fail flags with an explicit "off" penalty setting, finale and rematch ([M5](https://github.com/minercan42-ux/banger-roulette/pull/7), [#44](https://github.com/minercan42-ux/banger-roulette/pull/44)).
- Synthesized casino sound effects (no audio files) with an on/off toggle in the header ([#52](https://github.com/minercan42-ux/banger-roulette/pull/52)); Pixel-Filz design tokens (the former casino tokens and utilities are removed, [#71](https://github.com/minercan42-ux/banger-roulette/issues/71)), chips and a global focus ring on the frame ([#39](https://github.com/minercan42-ux/banger-roulette/pull/39)).
- German and English UI, 360 px layout, reduced motion, keyboard operation and screen-reader phase announcements ([#40](https://github.com/minercan42-ux/banger-roulette/pull/40)).
- Persistent privacy notice on every screen: YouTube is embedded from `youtube-nocookie.com` only after the one-time consent from the start popup, no analytics, no cookies, only a random player ID, the YouTube consent flag and the volume/mute/SFX preferences in localStorage ([#55](https://github.com/minercan42-ux/banger-roulette/pull/55), [#111](https://github.com/minercan42-ux/banger-roulette/issues/111), NFR-04).
- Gates in CI: 250 kB gzip initial-JS budget ([#47](https://github.com/minercan42-ux/banger-roulette/pull/47)), Lighthouse Performance desktop ≥ 90 and mobile ≥ 80, median of three runs ([#49](https://github.com/minercan42-ux/banger-roulette/pull/49)), and a strict-CSP regression with zod in jitless mode so no `eval` probe fires ([#48](https://github.com/minercan42-ux/banger-roulette/pull/48)).

- Product and architecture spec: [SPEC.md](SPEC.md)
- Rules for coding agents: [AGENTS.md](AGENTS.md)
- Approved defaults and unresolved gates: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Accepted security boundaries: [docs/SECURITY.md](docs/SECURITY.md)

## Local development

Use Node 24 (see `.nvmrc`) and the exact `packageManager` version of pnpm.

```sh
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The landing page and DE/EN language switch work without configuration; room actions require the two public Supabase values. `/r/CODE` discovers the live room and rebinds a retained identity after reload, otherwise asks for a nickname. Only four items are stored locally: the random `clientId` (identity), the YouTube embedding consent (`banger-roulette.youtubeConsent`) and the two UI preferences `banger-roulette.volume` (`{ level, muted }`) and `banger-roulette.sfx` (`{ enabled }`); no game or nickname is persisted. The newest accepted tab is writable, older tabs remain read-only.

Copy `.env.example` to `.env.local` yourself and fill only `VITE_SUPABASE_URL` (HTTPS project URL) and `VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`). Never use Secret/service_role, upload `.env.local` or share credentials in agent prompts. YouTube IFrame/oEmbed needs no Google API key.

`pnpm dev` serves the real `/api/time` and `/api/oembed` handlers on the same origin, with `Cache-Control: no-store`; unknown `/api` routes are not SPA HTML. The start popup ("Los geht's") unlocks local Web Audio and grants the YouTube embedding consent in one click, not YouTube autoplay; "Ohne Videos" unlocks audio only. The host can start when 3–10 players are ready. Song selection requires the embedding consent before any YouTube metadata, script, frame or thumbnail is requested; only actual playback with a positive duration for the entered video lets a link be submitted. Unavailable/embedding-forbidden videos are rejected with a localized message.

Paste a supported YouTube link: about a second later its preview starts and plays by itself, and once the preview confirms the link it is submitted automatically. `t=` provides the initial start suggestion; set the start point or adjust it by ±1/±5 seconds and the change is saved a second later. Done submits the pasted link, waits for the host to confirm it and only then finishes, even while the preview is still loading; without a link Done means sitting the round out. A browser that blocks the autoplay shows a "Play preview" button. Submissions remain editable/removable until Done or the host deadline, and a confirmed link counts at the deadline even without Done; Done is irreversible for that round. Reload restores your server-held submission, not an unsaved local draft; the stored embedding consent is read back. Pause and tab takeover cancel the preview and require fresh validation before further saving. Equal video IDs merge at selection end using the first remaining submitter's start; the linked presentation omits owners until reveal when anonymity is enabled.

Playback uses the host snapshot's absolute `startAt` and `deadlineAt`, with a three-second preroll per song. The same embedding consent covers submission, playback and reveal; it is remembered across reloads and can be revoked in the drawer. After consent the playback player is created invisibly during song selection, so it is ready when playback begins. During each preroll the clip buffers muted and becomes audible exactly at `startAt`; nothing is audible earlier. Local volume and mute never change another client's settings. A blocked player exposes a direct playback-recovery button; only YouTube's actual PLAYING event confirms playback. Buffering, advertisements and errors cannot delay the host's next-song deadline. Host pause freezes the timeline; resume shifts both timestamps. Genre-Fail can be set once per foreign song during playback, never for own/linked songs, spectators or obsolete write connections.

Append `?debug=1` to a room URL to inspect clock offset/RTT/synchronization, planned and observed start, start skew (content offset at the audible start), current drift and player status. Drift above 750 ms triggers a local seek; an independent deadline stops the clip because YouTube seeking invalidates its queued `endSeconds`. Cold first songs, heavy streams, ads and a loaded device can still miss AK-7's ±500 ms target. The overlay reports those misses rather than manufacturing successful timing; measure AK-7 with one client per device.

## Supported browsers

Chrome, Firefox, Edge (Chromium-based) and Safari are supported in their current versions (NFR-05); iOS Safari is checked manually on a real device and is not part of CI.

`playwright.config.ts` defines the projects `chromium`, `firefox` and `webkit` ([#50](https://github.com/minercan42-ux/banger-roulette/pull/50)). Pull requests and pushes to `main` stay Chromium-only because of the Actions minute budget; the nightly `schedule` run (03:00 UTC) and manual runs (`workflow_dispatch`) also run the `e2e-cross-browser` CI job for Firefox and WebKit. Locally: `pnpm exec playwright install firefox webkit` (never `--with-deps`, never sudo), then `pnpm test:e2e --project=firefox` or `--project=webkit`.

Known Firefox issue: the submission preview iframe stays in the tab order and can trap Tab ([#57](https://github.com/minercan42-ux/banger-roulette/issues/57), one harness test is marked `fixme` for it).

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm size:check
pnpm i18n:check
pnpm exec playwright install chromium
pnpm test:e2e --project=chromium
pnpm test:e2e:csp
```

`size:check` fails when the initial JS exceeds 250 kB gzip (NFR-01). `pnpm lighthouse` runs the Lighthouse CI gate (desktop ≥ 90, mobile ≥ 80); CI runs it as its own job.

`lint` checks ESLint boundaries and Prettier. UI may import only `src/engine/selectors.ts`, not engine internals; engine cannot import net/player/UI. `test` is Vitest with V8 coverage (production engine lines must reach 90%). `test:e2e` starts a test-only Vite/WebSocket bridge over the real in-memory transport and actual browser-hosted session/engine. Isolated contexts exercise lobby membership, settings, late joins, tab rebinding, reload/score recovery, migration during playback, sharing, DE/EN, keyboard, deep links, 360px and reduced motion. M3 covers common roulette results, duplicate submissions/first start/anonymity, denied embeds/consent, saved draft recovery, irreversible finish, deadlines, stale previews, pause and tab takeover. M4 adds different client wall clocks, observed PLAYING starts, drift thresholds, delayed cue/buffering, autoplay recovery, isolated errors, absolute deadlines, pause/resume/reload, consent and playback flag permissions. Only the external YouTube script/frame/thumbnail/oEmbed boundary is replaced; player, UI and session remain real. The harness and its debug API are not production build inputs. Synthetic timing is not evidence of live Supabase/YouTube timing.

`i18n:check` compares nested locale keys and interpolation variables. To validate separate fixtures: `node scripts/i18n-check.mjs path/to/de.json path/to/en.json`. Missing keys or mismatched placeholders exit nonzero.

## Live smoke

`pnpm test:e2e:live` ([#42](https://github.com/minercan42-ux/banger-roulette/pull/42)) runs `e2e-live/smoke.spec.ts` against a real deployment
(`playwright.live.config.ts`, `LIVE_BASE_URL`, default
`https://banger-roulette.vercel.app`). Four isolated browser contexts create,
join and play two full rounds of a game plus the first round of the rematch
through the UI only, covering AK-1 (identical genre and wheel), AK-2 (linked
song appears once, both owners score, neither can rate or flag it), AK-3 (no
owner before REVEAL), AK-4 (host migration < 5 s), AK-5 (reload rejoin < 5 s
with an unchanged total) and the rematch reset (every total is the new game's
own round). The `?debug=1` context also records the AK-7 start-skew and drift
values per song as Playwright annotations. It fails on any application console
error, CSP violation or Realtime channel error. No secret is required: the
publishable Supabase key is baked into the deployment, and no local `webServer`
is started.

It is deliberately **not** part of the PR `CI` workflow. `.github/workflows/live-smoke.yml`
runs it on `workflow_dispatch` (input `base_url`, default the production alias)
and always uploads the HTML report. There is no automatic trigger ([#54](https://github.com/minercan42-ux/banger-roulette/pull/54), issue [#51](https://github.com/minercan42-ux/banger-roulette/issues/51)): a
GitHub-hosted runner cannot pass it, because a Vercel Production
`deployment_status` carries a per-deployment URL that Deployment Protection
answers with `302` to `vercel.com/sso-api`, and YouTube answers a runner's
datacenter IP with `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot"),
which the player surfaces as `onError` 150 for every fixture video. Run the smoke
from a network where YouTube serves playback (a host run), see
[`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md). It needs network access to the deployment, Supabase
Realtime and YouTube, so expect a multi-minute runtime; AK-7's ±500 ms start
criterion stays a separate per-device acceptance and is only measured, never
asserted, here.

The collector and the `assertClean` assertion live in `e2e-live/csp-watch.ts` and
are shared with the offline regression `e2e/csp/live-csp-collector.spec.ts`,
which is part of `pnpm test:e2e:csp`: it runs both on the production build under the
exact `vercel.json` policy and against a routed same-origin script that performs
a caught, non-empty `eval`. A reintroduced CSP exemption therefore fails PR CI
instead of silently weakening the smoke.

## Supabase setup (user only)

1. [Dashboard](https://supabase.com/dashboard) → **New project** → organisation → name and EU region → choose a database password locally in your password manager → **Create project**. No table is required.
2. Project → **Connect** for Project URL; **Settings → API Keys** for **Publishable key**. Put those two public values in `.env.local`; never use Secret/service_role.
3. Project → **Realtime → Settings** → enable Realtime service and public channel access. This is the accepted unauthenticated MVP boundary; do not add Auth/RLS/tables.
4. Free projects can pause after inactivity. Before a demo, check the overview and **Restore/Resume** if paused. No keepalive, database or additional credentials are needed.

## Vercel deployment (user only)

1. [New project](https://vercel.com/new) → **Import Git Repository** → authorise the GitHub app only for `minercan42-ux/banger-roulette` → **Import**.
2. Root `./`, framework **Vite**, build `pnpm build`, output `dist`, install `pnpm install --frozen-lockfile`. Reviewed PR branches generate Previews; approved squash merges to `main` trigger Production.
3. **Settings → Environment Variables** → add only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to Production/Preview/Development → **Save**. Env changes need a new deployment: **Deployments → … → Redeploy**.
4. **Settings → Git → Production Branch** stays `main`. No direct main pushes. Check Preview `/`, create a room, join its `/r/CODE` link in another browser, reload, switch DE/EN, and inspect browser errors. `/api/time` must return JSON with `no-store`; local development does not prove Vercel routing or headers.
5. GitHub → **Pull requests → the milestone PR → Checks**: CI green and independent review required. Merge only by the user or explicit approval, using **Squash and merge**.

`vercel.json` excludes `/api` from SPA rewrites and adds CSP/Referer/nosniff headers. `connect-src` permits only the same origin and the exact HTTPS/WSS origins for the configured Supabase project, never a wildcard. If you change projects, update those origins with the environment configuration before deployment. `/api/time` returns server milliseconds; `/api/oembed?videoId=...` accepts only one valid video ID, fetches a fixed YouTube endpoint and returns validated text metadata, never embed HTML. No additional key or environment variable is needed.

Five-second migration/rejoin is measured, not guaranteed by Presence: delayed disconnect detection, lost messages, browser scheduling and partitions can miss the target. Recovery needs a surviving complete snapshot; closing every client loses the session. See [ADR-002](docs/ADR-002-session-authority.md) for atomic host/tab authority and the explicitly approved five-second **no-progress** snapshot timeout.

For this private repository, Vercel must associate the deployment commit with a GitHub account that has project access. Assistant-generated commits are published on behalf of the authenticated owner using the owner's public GitHub `ID+USERNAME@users.noreply.github.com` address, with explicit assistant attribution. Do not use an unlinked `assistant@localhost` address for a Preview trigger, read private email settings, disable access checks or rewrite published history just to trigger deployment. See [GitHub commit attribution](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference#your-noreply-email-address) and [Vercel author access](https://vercel.com/docs/deployments/troubleshoot-project-collaboration).
