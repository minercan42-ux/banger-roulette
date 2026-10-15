import { defineConfig } from '@playwright/test';

/**
 * Config for `playwright merge-reports` in the sharded PR E2E job (ci.yml).
 *
 * The blob reports come from two configs with different test directories
 * (`e2e` and `e2e/csp`); merging refuses that unless a merge config names a
 * common root. See https://playwright.dev/docs/test-sharding.
 */
export default defineConfig({
  testDir: '.',
  reporter: [['list'], ['html', { open: 'never' }]],
});
