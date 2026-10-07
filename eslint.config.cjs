const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const ts = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = defineConfig({
  files: ['src/**/*.ts'],
  extends: [js.configs.recommended, ts.configs['flat/recommended']],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    globals: { ...globals.node, ...globals.es2022 },
  },
  rules: {
    // CDP and browser-evaluated expressions include intentionally dynamic values.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
});
