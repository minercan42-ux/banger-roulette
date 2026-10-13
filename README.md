# Banger Roulette

Browser party game: each round a genre is spun on a roulette wheel, every player submits a YouTube link to their biggest banger, everyone listens to the snippets in sync, ranks the others and scores points. No login, casino vibe, German and English UI.

Status: M0 is merged and deployed at [banger-roulette.vercel.app](https://banger-roulette.vercel.app/), with green hosted CI and actual production smoke acceptance. The user approved production-first verification for PR #2. M1's pure engine, scoring and filtered selectors are implemented on the engine feature branch, pending release review/CI and separate merge approval. The deployed shell is not a playable game; Realtime, YouTube player, gameplay UI and API Functions are later milestones.

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

The shell works without environment variables. Detects German/English from browser preferences, falls back to German and switches language without reloading. `/r/ABCDEF` currently opens the same empty shell; it does not create or join a room.

For later Realtime work, copy `.env.example` to `.env.local` yourself and fill only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. These are public client configuration, not secret/service-role keys. Never upload `.env.local` or share credentials in agent prompts. YouTube IFrame/oEmbed needs no Google API key.

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

`lint` checks ESLint boundaries and Prettier. UI may import only `src/engine/selectors.ts`, not engine internals; engine cannot import net/player/UI. `test` is Vitest with V8 coverage (M1 engine lines must reach 90%). `test:e2e` starts Vite automatically and exercises three isolated Chromium contexts, language switching, keyboard operation, deep-link reload, 360px width and reduced motion. There are no live Supabase/YouTube calls in tests.

`i18n:check` compares nested locale keys and interpolation variables. To validate separate fixtures: `node scripts/i18n-check.mjs path/to/de.json path/to/en.json`. Missing keys or mismatched placeholders exit nonzero.

## Supabase setup (user only)

1. [Dashboard](https://supabase.com/dashboard) → **New project** → organisation → name and EU region → choose a database password locally in your password manager → **Create project**. No table is required.
2. Project → **Connect** for Project URL; **Settings → API Keys** for **Publishable key**. Put those two public values in `.env.local`; never use Secret/service_role.
3. Project → **Realtime → Settings** → enable Realtime service and public channel access. This is the accepted unauthenticated MVP boundary; do not add Auth/RLS/tables.
4. Free projects can pause after inactivity. Before a demo, check the overview and **Restore/Resume** if paused. No keepalive or database is needed for M0.

## Vercel deployment (user only)

1. [New project](https://vercel.com/new) → **Import Git Repository** → authorise the GitHub app only for `minercan42-ux/banger-roulette` → **Import**.
2. Root `./`, framework **Vite**, build `pnpm build`, output `dist`, install `pnpm install --frozen-lockfile`. Import a reviewed M0 branch or approved merged M0, not pre-M0 main. The first project deployment is Production; subsequent PRs generate Previews.
3. **Settings → Environment Variables** → add only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to Production/Preview/Development → **Save**. Env changes need a new deployment: **Deployments → … → Redeploy**.
4. **Settings → Git → Production Branch** stays `main`. No direct main pushes. Visit Preview `/` and `/r/ABCDEF`, reload each, switch DE/EN and inspect console errors. Local Vite fallback does not prove Vercel routing.
5. GitHub → **Pull requests → M0 PR → Checks**: CI green and independent review required. Merge only by the user or explicit approval, using **Squash and merge**.

`vercel.json` excludes `/api` from SPA rewrites and adds CSP/Referer/nosniff headers. M0 has no Functions and no third-party connections; `connect-src` is self-only. M2 must add exact project-specific Supabase HTTPS/WSS origins. Later Functions milestones use `vercel dev` for same-origin app/API development; authorise CLI login/link yourself without sharing tokens.
