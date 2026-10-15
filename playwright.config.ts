import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec vite --config e2e/vite.config.ts',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      // `e2e/csp` runs against the production preview, not this dev server.
      testIgnore: '**/csp/**',
      use: { browserName: 'chromium' },
    },
  ],
});
