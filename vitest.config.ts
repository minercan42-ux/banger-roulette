import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts', 'src/engine/**/*.ts'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', 'src/engine/fixtures.ts'],
      thresholds: { 'src/engine/**': { lines: 90 } },
    },
  },
});
