import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  // `e2e/csp` runs against the production preview (`playwright.csp.config.ts`),
  // not this dev server, so it is ignored in every project.
  testIgnore: '**/csp/**',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --config e2e/vite.config.ts',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  // NFR-05: pull requests stay Chromium-only (Actions minute budget); Firefox
  // and WebKit run on `main` and on `workflow_dispatch` in the
  // `e2e-cross-browser` CI job. `pnpm test:e2e` runs all three projects.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
