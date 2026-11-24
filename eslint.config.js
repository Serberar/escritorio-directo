'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node } },
  { files: ['ui/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, frames: 'off', api: 'readonly' } } },
  { files: ['ui/{home,panel,viewer}.js'], languageOptions: { globals: { fmt: 'readonly', applyBrand: 'readonly' } } },
  { files: ['src/preload.js'], languageOptions: { globals: globals.browser } },
  { files: ['test/{e2e,resilience,por-id}.js'], languageOptions: { globals: { ...globals.browser, api: 'readonly', conf: 'readonly', waitKey: 'readonly', live: 'readonly', dec: 'readonly', frames: 'readonly', canvas: 'readonly', ctx: 'readonly', caps: 'readonly', st: 'readonly', msg: 'readonly' } } },
  { rules: { 'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }] } },
  { files: ['ui/common.js'], rules: { 'no-unused-vars': 'off' } },
];
