# AGENTS.md

Working rules for every agent (orchestrator and subagents) in this repository.
The product and architecture spec is `SPEC.md`. Read it before doing anything. If this file and `SPEC.md` disagree, `SPEC.md` wins and you report the conflict.

## Golden rules
1. Never push to `main`. One branch per task, open a pull request, wait for green CI and the user's approval to merge.
2. Never commit secrets. `.env.local` is gitignored. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` exist; a service_role or secret key must never appear anywhere in this repo.
3. Stay inside the directories your task allows (see SPEC.md section 9). Contracts in `src/shared/` are changed only by the orchestrator.
4. Check external APIs (YouTube IFrame API, oEmbed, Supabase Realtime, Vercel) against current official docs. Do not implement from memory.
5. Unclear requirement: pick a sensible default, record it in `docs/OPEN_QUESTIONS.md` with the reasoning, continue. High-impact product decision: stop and ask the user.
6. Something only the user can do (account, key, setting): stop and describe it with a concrete click path.

## Branches and commits
- Branch names: `feat/<scope>-<short-desc>`, `fix/...`, `chore/...`, `docs/...`, `test/...` (e.g. `feat/engine-scoring`).
- Conventional Commits in English: `feat(engine): add borda scoring`. Scopes: `engine`, `net`, `player`, `ui`, `shared`, `content`, `e2e`, `ci`, `docs`.
- Small, focused PRs. Fill in the PR template, reference the FR/NFR/AK IDs from SPEC.md.
- Merge strategy is squash merge; branches are deleted after merge.

## Commands (contract for CI, created in M0)
| Script | Purpose |
|---|---|
| `pnpm lint` | ESLint (incl. boundary rules) and Prettier check |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Vitest unit tests with coverage (engine >= 90 % lines) |
| `pnpm build` | Production build |
| `pnpm size:check` | Fails if initial JS gzip exceeds 250 kB (NFR-01) |
| `pnpm i18n:check` | Fails if any locale is missing keys (AK-9) |
| `pnpm test:e2e` | Playwright E2E, multiple browser contexts |

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` locally before every push.

## Definition of Done (per task)
- Acceptance criteria of the referenced FR/AK IDs are met and covered by tests.
- CI is green, no new lint warnings, no `any` without a justifying comment.
- No hardcoded UI strings; DE and EN keys exist.
- Docs updated where behaviour or architecture changed (ADR for architecture decisions).
- Reviewed by an agent that did not write the code.

## Repo layout (target)
```
src/engine/    pure game logic, no imports from net/player/ui, injected time + RNG
src/net/       GameTransport interface, Supabase + in-memory adapters, clock sync
src/player/    YouTube IFrame wrapper, link parsing, oEmbed, embed validation
src/ui/        screens and components, reads selectors, dispatches actions
src/shared/    types and zod schemas (contracts)
src/content/   genres.json, i18n locale files
api/           Vercel functions (time, oembed)
e2e/           Playwright tests
docs/          ADRs, ARCHITECTURE, SECURITY, OPEN_QUESTIONS, ROADMAP
```
