// Minimal ESLint flat config for the shell and the TypeScript services: eslint's and typescript-eslint's recommended
// rules (no type-aware rules, no formatting rules) plus React's two hook rules. Run from the repository root (with
// --config the working directory is the base path):
//   tools/lint/node_modules/.bin/eslint --config tools/lint/eslint.config.mjs
//
// Rules scoped down here, and why:
// - no-explicit-any: off. `any` marks the untyped D-Bus / IPC / JSON boundaries on purpose; tsc --noEmit (strict)
//   is the type gate.
// - no-unused-vars: a leading underscore marks a deliberately unused name (rest-omission, callback arity); unused
//   catch bindings are allowed.
// - no-control-regex: off. The control-character classes are the input sanitisers (strip/refuse \x00-\x1f in
//   names, paths and CUPS/printer fields), which is what the rule would flag.
// - react-hooks/exhaustive-deps: warning only (the code already carries intentional disables for it).
// - Tests: require() and space-padded expected-output regexes are fine in tests.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', 'live-build/**', 'packaging/out/**'],
  },
  {
    files: ['shell/**/*.{ts,tsx,js,mjs,cjs}', 'services/**/*.{ts,mjs,js}', 'tools/**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
      'no-control-regex': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.test.{ts,tsx,mjs}', '**/test/**'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-regex-spaces': 'off',
    },
  },
);
