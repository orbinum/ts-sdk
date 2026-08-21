import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // forks: better compatibility with CJS (circomlibjs) and native ESM (@noble/*)
    pool: 'forks',
    // The suite builds real notes: Poseidon hashes and elliptic-curve
    // multiplications, tens of them per test. That fits inside the 5s default
    // on an idle machine and does NOT when the tests share a box with the
    // build, as they do under `pnpm check` — which turned a green suite into
    // three or four timeouts that moved around between runs. Raised so a slow
    // machine reports real failures instead of noise.
    testTimeout: 30_000,
  },
  resolve: {
    // Allow vitest to resolve .js extension imports to .ts source files
    extensions: ['.ts', '.js'],
  },
});
