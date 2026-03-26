import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // forks: better compatibility with CJS (circomlibjs) and native ESM (@noble/*)
    pool: 'forks',
  },
  resolve: {
    // Allow vitest to resolve .js extension imports to .ts source files
    extensions: ['.ts', '.js'],
  },
});
