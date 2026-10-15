import { defineConfig } from '@playwright/test';

/**
 * Live smoke configuration (M7 / issue #20). Unlike `playwright.config.ts` this
 * suite runs against a real deployment: no `webServer`, no in-memory bridge, no
 * `window.__banger` harness. Everything is driven and observed through the real
 * UI, so it is deliberately slow, single-worker and only triggered manually: on a
 * host (`pnpm test:e2e:live`) or via `workflow_dispatch` in `live-smoke.yml`.
 * There is no automatic trigger, because a GitHub-hosted runner cannot pass the
 * YouTube playback steps (see `docs/OPEN_QUESTIONS.md`, issue #51).
 */
export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 20 * 60 * 1000,
  expect: { timeout: 30_000 },
  retries: 1,
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'https://banger-roulette.vercel.app',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
