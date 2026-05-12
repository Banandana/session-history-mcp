import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginPromise from 'eslint-plugin-promise'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'fixtures/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      promise: eslintPluginPromise,
      unicorn: eslintPluginUnicorn,
    },
    rules: {
      // Promise hygiene — catches real bugs (forgotten await, callback-style)
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'promise/prefer-await-to-callbacks': 'warn',

      // setTimeout/setInterval discouraged — almost always a code smell here
      'no-restricted-globals': [
        'warn',
        { name: 'setTimeout', message: 'Prefer async/await or a scheduler' },
        { name: 'setInterval', message: 'Prefer proper scheduling' },
      ],

      // Unused vars — allow `_`-prefix opt-out. Demoted to warn because the
      // codebase has accumulated dead imports; clean up incrementally instead
      // of blocking lint on legacy cruft.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Style
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/no-process-exit': 'warn',

      // Codebase pragmatics — explicit-any tolerated, sqlite/JSON layers
      // would explode under strict-type-checked. Revisit per-file via overrides.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  prettierConfig,
)
