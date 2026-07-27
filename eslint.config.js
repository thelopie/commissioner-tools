import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Emitted declaration files for the frontend. Generated output should not be
      // held to source style rules.
      '**/dist-types/**',
      '**/build/**',
      '**/coverage/**',
      '**/cdk.out/**',
      '**/*.tsbuildinfo',
      'certs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // The browser bundle must never read process.env: Vite would inline the value
    // into publicly served JavaScript. All secrets stay server-side, and the
    // frontend receives what it needs from API responses.
    //
    // Scoped to src/ only — vite.config.ts runs in Node at build time, where
    // reading process.env is correct and never reaches the bundle.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'No process.env in the browser bundle — secrets would leak.' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/fixtures/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
