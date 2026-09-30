import { defineConfig } from 'vitest/config';

// Test files run one after another, and every in-memory SQLite database is closed after each file
// (tests/setup.js). Twice a Vitest worker exited ("Worker exited unexpectedly") during full runs on Windows while
// the live server, agent and MySQL were also running; every file passed on its own. See docs/test-results.md.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    setupFiles: ['./tests/setup.js'],
  },
});
