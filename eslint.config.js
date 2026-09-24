// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  security.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', 'scripts/*.mjs', '.claude/hooks/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Code-smell guardrails (see CLAUDE.md "Definition of Done").
      'sonarjs/cognitive-complexity': ['error', 15],
      complexity: ['error', 20],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Typed-array index access in hot loops is intentional and bounds-checked by construction.
      'security/detect-object-injection': 'off',
      // Numeric code (geo math, codecs) legitimately uses these.
      'sonarjs/pseudo-random': 'off',
      'no-bitwise': 'off',
    },
  },

  // React app
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Node code: API, scripts, hooks, config files
  {
    files: [
      'apps/api/**/*.ts',
      'scripts/**/*.mjs',
      '.claude/hooks/**/*.mjs',
      'tests/**/*.mjs',
      '*.{js,mjs}',
      '**/*.config.{ts,js,mjs}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['scripts/**/*.mjs', '.claude/hooks/**/*.mjs', 'apps/api/src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      // CLI scripts intentionally spawn processes and touch paths derived from their inputs.
      'sonarjs/no-os-command-from-path': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
    },
  },

  // Tests: relax rules that fight idiomatic test code.
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'max-params': 'off',
    },
  },

  // Plain JS files are not type-checked.
  {
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
