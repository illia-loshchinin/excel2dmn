export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
];
