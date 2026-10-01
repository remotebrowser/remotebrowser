import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDatabase } from './postgres.js';

// No real Postgres server runs in this test environment. This only checks the
// fail-fast behavior: a bad connection target must reject at open time, not on
// the first query.
test('createPostgresDatabase rejects immediately when it cannot reach the server', async () => {
  await assert.rejects(createPostgresDatabase({ connectionString: 'postgres://user:pass@127.0.0.1:1/db' }));
});
