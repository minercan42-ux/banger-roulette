# Working model: owner, PM and subagents

This is how work on Banger Roulette is organized. It binds every agent in this repository. SPEC.md section 9 points here; AGENTS.md golden rules 1 and 3 follow it.

## Roles

| Role                    | Who                                                | Does                                                                                                                          | Does not                                                   |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Owner (stakeholder)** | `@minercan42-ux`                                   | Decides product direction, design taste, scope and priorities; playtests; changes accounts, billing and GitHub settings       | Write code, review PRs, merge (unless they choose to)      |
| **PM (orchestrator)**   | The main agent session the owner talks to          | Turns owner requests into issues, plans waves, spawns and steers subagents, runs the merge gate, merges, reports to the owner | Implement features itself, edit files in the main checkout |
| **Implementer**         | Subagent per issue (agent definitions below)       | One issue as one branch and one PR in its own worktree, tests, screenshots for visual work, green CI                          | Merge, push to `main`, widen scope                         |
| **Reviewer**            | Subagent on a different model than the implementer | One `REVIEW: PASS @ <sha>` or `REVIEW: CHANGES @ <sha>` comment per review round                                              | Edit code                                                  |

## Lifecycle of a request

1. **Request.** The owner describes what they want, in German, often several items at once.
2. **Issue.** The PM creates one issue per item. The body has the sections Context, Change or Scope, Acceptance criteria, Owned files, Blocked by. It records decisions the PM made on the owner's behalf so the owner can override them. Issues created by the PM for the owner count as the explicit assignment AGENTS.md rule 7 requires.
3. **Start.** The PM checks open blockers, creates a worktree under `../wt/<issue>-<key>` from `origin/main`, sets the board status to In Progress and comments `claimed: <agent>, branch <branch>`.
4. **Implement.** The implementer works only in its worktree, runs the local gate, opens the PR (template filled, `Closes #N`), waits for green CI and yields head SHA, CI run id, acceptance evidence, deviations and the screenshot list.
5. **Review.** A reviewer on a different model reviews the exact head.
6. **Fix loop.** On CHANGES the PM spawns a fix round with the verbatim findings. After two CHANGES rounds the PM runs one final targeted fix round or escalates to a stronger model. There is never a merge without a fulfilled merge gate.
7. **Merge gate (PM).** All four must hold:
   - every check passes or is skipped;
   - the last `REVIEW:` comment is `PASS @ <current head>`, or it is `PASS` on an earlier head and the only change since then is a conflict-free rebase that leaves the PR's own patch unchanged; in that case the PM records the carry-over as a PR comment (`REVIEW: PASS @ <old> carries over to <new>`) before merging;
   - `origin/main` is an ancestor of the branch;
   - for visual PRs, the PM has read the screenshots and posted `PM visual gate: PASS`.

   A rebase that needed manual conflict resolution, or any other change to the PR's own patch, needs a re-review.

8. **Merge.** The PM squash-merges, deletes the branch, removes the worktree and verifies that the issue is closed and the board item is Done.
9. **Report.** The PM reports to the owner in German: concise, tables, no em-dashes, facts only.

## Rules the PM enforces

- **Concurrency.** At most three subagents run at the same time (implementers and reviewers together). Heavy local checks are serialized host-wide with `flock /tmp/br-check.lock`.
- **Stuck check per agent.** Every subagent gets its own timer. After each full hour of its runtime the PM checks only that agent: new commits or pushes, CI progress, and its transcript. If it is stuck, the PM replaces it with a stronger model on the same worktree. The owner's omp hook `~/.omp/agent/hooks/post/br-stuck-check.ts` enforces the check: it wakes the PM after each full hour of an agent's runtime.
- **Model ladder.** For non-visual work: DeepSeek, then Sonnet, then GPT. For visual work: Sonnet, then GPT. Visual work and visual judgement never run on DeepSeek.
- **Local gate.** `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size:check && pnpm i18n:check`, plus only the Playwright specs the change adds or modifies. The full e2e suite runs in CI; CI green is mandatory.
- **Review policy.** A review blocks only for real bugs, security or privacy issues, AK-2/AK-3 anonymity leaks, or unmet acceptance criteria. There are no demands for tests of tests. Minor findings are non-blocking; the PM collects them into a follow-up or cleanup issue.
- **Commit identity.** `minercan42-ux <291378615+minercan42-ux@users.noreply.github.com>`. The owner's private address must never appear in a commit; GitHub blocks such pushes.
- **Owner-only actions.** Accounts, billing, keys, repository settings and model limits are changed only by the owner. The PM describes the click path and waits.
- **Limits.** When a model provider reports a quota or rate limit, the PM finishes or parks the affected work, keeps partial worktree state, tells the owner, and resumes with fresh agents that continue from the worktree.
- **Decision log.** Every owner decision, and every decision the PM takes on the owner's behalf, gets an entry in `docs/DECISIONS.md` (German, focused on why, with rejected alternatives and links), in the same PR or a small docs PR right after. Entries are never deleted; superseded ones are marked `Status: ersetzt durch D-xxx`. Agent-level technical defaults stay in `docs/OPEN_QUESTIONS.md`, architecture in `docs/ADR-*.md`.

## Visual work

- Screenshots go to `../shots/<issue>/` and to the branch `assets/issue-<issue>`, embedded in the PR body. They are German, desktop 1280x800 first (desktop first is an owner decision), plus 360x740, with reduced motion on and off.
- The binding visual system is `docs/design/pixel-filz/` plus the owner decisions recorded in issues and PRODUCT.md. On top of it, implementers and reviewers apply the design skills `frontend-design` and `impeccable` (installed at `~/.omp/agent/skills/`; see PRODUCT.md for product context).

## Labels the owner uses

| Label                        | Meaning                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `playtest`                   | Found in an owner playtest. "Arbeite an allen Playtest-Issues" means: work all open issues with this label. |
| `plan`, `no-agent-pickup`    | Plans; never implemented without a task issue (AGENTS.md rule 7).                                           |
| `type:*`, `area:*`, `prio:*` | Kind, area and priority, as everywhere in this repository.                                                  |

## Tools outside the repository

- **Agent definitions** (owner's omp user config, `~/.omp/agent/agents/`):

  | Agent                | Model    | Role                                             |
  | -------------------- | -------- | ------------------------------------------------ |
  | `br-backend-dev`     | DeepSeek | Non-visual implementer: rebases, CI, logic, docs |
  | `br-ui-dev-claude`   | Sonnet   | Implementer for all visual work                  |
  | `br-ui-dev-gpt`      | GPT      | Escalation implementer                           |
  | `br-reviewer-gpt`    | GPT      | Default reviewer                                 |
  | `br-reviewer-claude` | Sonnet   | Fallback reviewer                                |

- **Stuck-check hook** (owner's omp user config, `~/.omp/agent/hooks/post/br-stuck-check.ts`): for sessions whose working directory is inside the banger-roulette project it tracks every subagent the session spawns (`task`) or revives (`write agent://<id>`), notices when one finishes and, after each full hour of an agent's runtime, sends an `aside` message that wakes the PM (also out of a running `wait`) with the check list: commits and pushes in the worktree, CI and dispatch runs of the branch, and the transcript tail. It also shows `agents: <name> <age>` in the status line. It is scoped to this project and takes effect from the next omp session start.
- **Playtest bots:** `../playtest/bots.mjs` (README alongside). Join an owner room: `node bots.mjs --room CODE --bots 2`. Create a room: `node bots.mjs --bots 3 --min-players 3 [--fast]`. The bots run headless and muted against production. When a UI or rules change breaks them, the issue that causes the break also updates the bots.
- **Board:** GitHub project 1 of `minercan42-ux`. Its Status field moves to In Progress at claim and to Done at merge.
