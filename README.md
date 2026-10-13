# Banger Roulette

Browser party game: each round a genre is spun on a roulette wheel, every player submits a YouTube link to their biggest banger, everyone listens to the snippets in sync, ranks the others and scores points. No login, casino vibe, German and English UI.

Status: M2 implements a real Supabase lobby, room links, settings, reconnect/migration, and `/api/time`. Production at [banger-roulette.vercel.app](https://banger-roulette.vercel.app/) follows separately approved squash merges to `main`; release evidence is recorded in each milestone PR. The game is not yet playable: YouTube, song-selection and gameplay screens follow in M3–M5.

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

`pnpm dev` serves the real `/api/time` handler on the same origin, with `Cache-Control: no-store`; unknown `/api` routes are not SPA HTML. M2's explicit sound-consent click unlocks local Web Audio, not a proof of future YouTube autoplay. No YouTube iframe/API loads yet, and game start remains unavailable in the lobby until the gameplay/player milestones.

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

`lint` checks ESLint boundaries and Prettier. UI may import only `src/engine/selectors.ts`, not engine internals; engine cannot import net/player/UI. `test` is Vitest with V8 coverage (production engine lines must reach 90%). `test:e2e` starts a test-only Vite/WebSocket bridge over the real in-memory transport and actual browser-hosted session/engine. Isolated contexts exercise lobby membership, settings, late joins, tab rebinding, reload/score recovery, migration during voting, sharing, DE/EN, keyboard, deep links, 360px and reduced motion. The harness and its debug API are not production build inputs. There are no live Supabase/YouTube calls in automated tests; real Supabase timing is a separate smoke measurement.

`i18n:check` compares nested locale keys and interpolation variables. To validate separate fixtures: `node scripts/i18n-check.mjs path/to/de.json path/to/en.json`. Missing keys or mismatched placeholders exit nonzero.

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

`vercel.json` excludes `/api` from SPA rewrites and adds CSP/Referer/nosniff headers. `connect-src` permits only the same origin and the exact HTTPS/WSS origins for the configured Supabase project, never a wildcard. If you change projects, update those origins with the environment configuration before deployment. `/api/time` is the only M2 Function; oEmbed is M3. For Vercel-runtime-specific checks, authorise `vercel dev` login/link yourself without sharing tokens.

Five-second migration/rejoin is measured, not guaranteed by Presence: delayed disconnect detection, lost messages, browser scheduling and partitions can miss the target. Recovery needs a surviving complete snapshot; closing every client loses the session. See [ADR-002](docs/ADR-002-session-authority.md) for atomic host/tab authority and the explicitly approved five-second **no-progress** snapshot timeout.

For this private repository, Vercel must associate the deployment commit with a GitHub account that has project access. Assistant-generated commits are published on behalf of the authenticated owner using the owner's public GitHub `ID+USERNAME@users.noreply.github.com` address, with explicit assistant attribution. Do not use an unlinked `assistant@localhost` address for a Preview trigger, read private email settings, disable access checks or rewrite published history just to trigger deployment. See [GitHub commit attribution](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference#your-noreply-email-address) and [Vercel author access](https://vercel.com/docs/deployments/troubleshoot-project-collaboration).
