import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'dist/',
    'coverage/',
    'src/routeTree.gen.ts',
    'e2e/**',
    'playwright-report/**',
    'test-results/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettier,
    ],
    rules: {
      // TanStack Router files export a `Route` object next to their component; the app router exports `router`.
      'react-refresh/only-export-components': ['error', { allowExportNames: ['Route', 'router'] }],
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
]);
