// Close every SQLite database a test file opened, instead of leaving native handles to the garbage collector.
import { afterAll } from 'vitest';
import { closeAllOpenDatabases } from '../src/db/index.js';

afterAll(async () => {
  await closeAllOpenDatabases();
});
