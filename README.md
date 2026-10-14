# Banger Roulette

Browser party game: each round a genre is spun on a roulette wheel, every player submits a YouTube link to their biggest banger, everyone listens to the snippets in sync, ranks the others and scores points. No login, casino vibe, German and English UI.

Status: M4 adds server-time-scheduled YouTube playback, drift correction, local audio controls and a `?debug=1` overlay to the M3 genre/submission flow and M2 realtime lobby. Production at [banger-roulette.vercel.app](https://banger-roulette.vercel.app/) follows separately approved squash merges to `main`; release evidence is recorded in each milestone PR. Voting, reveal and the finale follow in M5. This is not yet a complete playable game, and real-service timing acceptance remains a separate gate.

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

The landing page and DE/EN language switch work without configuration; room actions require the two public Supabase values. `/r/CODE` discovers the live room and rebinds a retained identity after reload, otherwise asks for a nickname. Only `clientId` is stored locally; no game or nickname is persisted. The newest accepted tab is writable, older tabs remain read-only.

Copy `.env.example` to `.env.local` yourself and fill only `VITE_SUPABASE_URL` (HTTPS project URL) and `VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`). Never use Secret/service_role, upload `.env.local` or share credentials in agent prompts. YouTube IFrame/oEmbed needs no Google API key.

`pnpm dev` serves the real `/api/time` and `/api/oembed` handlers on the same origin, with `Cache-Control: no-store`; unknown `/api` routes are not SPA HTML. Lobby sound consent unlocks local Web Audio, not YouTube autoplay. The host can start when 3–10 players are ready. Song selection requires separate per-tab embedding consent before any YouTube metadata, script, frame or thumbnail is requested; only actual playback with a positive duration for the entered video enables saving. Unavailable/embedding-forbidden videos are rejected with a localized message.

Choose a supported YouTube link, load and play its preview, set the start point or adjust it by ±1/±5 seconds, then save. `t=` provides the initial start suggestion. Saved submissions remain editable/removable until Done or the host deadline; Done is irreversible for that round. Reload restores your server-held submission, not an unsaved local draft or embedding consent. Pause and tab takeover cancel the preview and require fresh validation before further saving. Equal video IDs merge at selection end using the first remaining submitter's start; the linked presentation omits owners until reveal when anonymity is enabled.

Playback uses the host snapshot's absolute `startAt` and `deadlineAt`, with a three-second preroll per song. The same per-tab embedding consent covers submission and playback; reload starts without consent. After consent the playback player is created invisibly during song selection, so it is ready when playback begins. During each preroll the clip buffers muted and becomes audible exactly at `startAt`; nothing is audible earlier. Local volume and mute never change another client's settings. A blocked player exposes a direct playback-recovery button; only YouTube's actual PLAYING event confirms playback. Buffering, advertisements and errors cannot delay the host's next-song deadline. Host pause freezes the timeline; resume shifts both timestamps. Genre-Fail can be set once per foreign song during playback, never for own/linked songs, spectators or obsolete write connections.

Append `?debug=1` to a room URL to inspect clock offset/RTT/synchronization, planned and observed start, start skew (content offset at the audible start), current drift and player status. Drift above 750 ms triggers a local seek; an independent deadline stops the clip because YouTube seeking invalidates its queued `endSeconds`. Cold first songs, heavy streams, ads and a loaded device can still miss AK-7's ±500 ms target. The overlay reports those misses rather than manufacturing successful timing; measure AK-7 with one client per device.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm i18n:check
pnpm exec playwright install chromium
pnpm test:e2e
```

`lint` checks ESLint boundaries and Prettier. UI may import only `src/engine/selectors.ts`, not engine internals; engine cannot import net/player/UI. `test` is Vitest with V8 coverage (production engine lines must reach 90%). `test:e2e` starts a test-only Vite/WebSocket bridge over the real in-memory transport and actual browser-hosted session/engine. Isolated contexts exercise lobby membership, settings, late joins, tab rebinding, reload/score recovery, migration during voting, sharing, DE/EN, keyboard, deep links, 360px and reduced motion. M3 covers common roulette results, duplicate submissions/first start/anonymity, denied embeds/consent, saved draft recovery, irreversible finish, deadlines, stale previews, pause and tab takeover. M4 adds different client wall clocks, observed PLAYING starts, drift thresholds, delayed cue/buffering, autoplay recovery, isolated errors, absolute deadlines, pause/resume/reload, consent and playback flag permissions. Only the external YouTube script/frame/thumbnail/oEmbed boundary is replaced; player, UI and session remain real. The harness and its debug API are not production build inputs. Synthetic timing is not evidence of live Supabase/YouTube timing.

`i18n:check` compares nested locale keys and interpolation variables. To validate separate fixtures: `node scripts/i18n-check.mjs path/to/de.json path/to/en.json`. Missing keys or mismatched placeholders exit nonzero.

## Live smoke

`pnpm test:e2e:live` runs `e2e-live/smoke.spec.ts` against a real deployment
(`playwright.live.config.ts`, `LIVE_BASE_URL`, default
`https://banger-roulette.vercel.app`). Four isolated browser contexts create,
join and play two full rounds through the UI only, covering AK-1 (identical
genre and wheel), AK-2 (linked song appears once, both owners score, neither can
vote or flag it), AK-3 (no owner before REVEAL), AK-4 (host migration < 5 s) and
AK-5 (reload rejoin < 5 s with an unchanged total). The `?debug=1` context also
records the AK-7 start-skew and drift values per song as Playwright annotations.
It fails on any application console error, CSP violation or Realtime channel
error. No secret is required: the publishable Supabase key is baked into the
deployment, and no local `webServer` is started.

It is deliberately **not** part of the PR `CI` workflow. `.github/workflows/live-smoke.yml`
runs it on `workflow_dispatch` (input `base_url`) and automatically after a
successful Vercel Production `deployment_status`, always uploading the HTML
report. It needs network access to the deployment, Supabase Realtime and
YouTube, so expect a multi-minute runtime; AK-7's ±500 ms start criterion stays a
separate per-device acceptance and is only measured, never asserted, here.

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
