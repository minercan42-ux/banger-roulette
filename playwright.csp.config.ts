import { defineConfig } from '@playwright/test';

/**
 * Production-CSP regression for #43: the real build (`pnpm build`) served by
 * `vite preview` under the header from `vercel.json`.
 *
 * It runs on its own port and is wired into `pnpm test:e2e`, so it never shares
 * the harness server (4173) with the rest of the E2E suite. `--host 127.0.0.1`
 * is required: without it `vite preview` binds `localhost`, which resolves to
 * `::1` on some machines (including the CI runner) while Playwright probes
 * `127.0.0.1`.
 */
export default defineConfig({
  testDir: './e2e/csp',
  fullyParallel: true,
  // The sharded PR job (`PW_BLOB_REPORT`, see ci.yml) writes a blob report per
  // shard and merges them into one HTML report afterwards.
  reporter: process.env.PW_BLOB_REPORT
    ? [['list'], ['blob']]
    : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  webServer: {
    command:
      'pnpm build && pnpm exec vite preview --port 4174 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    // The build runs in this command; pipe stdout so its output is visible when
    // the server fails to come up.
    stdout: 'pipe',
    timeout: 180_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
