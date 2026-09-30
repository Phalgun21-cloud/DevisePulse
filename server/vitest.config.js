import { defineConfig } from 'vitest/config';

// Test files run one after another. With files in parallel, a Vitest worker intermittently exited
// ("Worker exited unexpectedly") on Windows while every file passed on its own; the heavy demo-seeding
// tests keep large in-memory SQLite databases. Cause not confirmed; see docs/test-results.md.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
