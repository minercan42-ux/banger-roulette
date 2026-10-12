import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { alwaysTryTypes: true } },
      'boundaries/elements': [
        ...['engine', 'net', 'player', 'ui', 'shared', 'content'].map(
          (type) => ({ type, pattern: `src/${type}/**`, partialMatch: false }),
        ),
      ],
      'boundaries/files': [
        { pattern: 'src/engine/selectors.ts', category: 'public-selector' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'engine' } },
              disallow: { to: { element: { type: ['net', 'player', 'ui'] } } },
            },
            {
              from: { element: { type: 'ui' } },
              disallow: { to: { element: { type: 'engine' } } },
            },
            {
              from: { element: { type: 'ui' } },
              allow: {
                to: {
                  element: { type: 'engine' },
                  file: { categories: 'public-selector' },
                },
              },
            },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/main.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
