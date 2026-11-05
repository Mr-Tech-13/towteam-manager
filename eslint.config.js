import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['*.js', 'tests/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser }
  }
];
