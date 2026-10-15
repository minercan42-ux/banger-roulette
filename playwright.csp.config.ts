import { defineConfig } from '@playwright/test';

/**
 * Production-CSP regression for #43: the real build (`pnpm build`) served by
 * `vite preview` under the header from `vercel.json`.
 *
 * It runs on its own port and is wired into `pnpm test:e2e`, so it never shares
 * the harness server (4173) with the rest of the E2E suite.
 */
export default defineConfig({
  testDir: './e2e/csp',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
