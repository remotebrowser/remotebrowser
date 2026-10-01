import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPgliteDatabase } from './pglite.js';

const withDatabase = async (callback) => {
  const database = await createPgliteDatabase({ dataDir: 'memory://' });
  try {
    await callback(database);
  } finally {
    await database.close();
  }
};

test('PGlite runs parameterized queries in memory', async () => {
  await withDatabase(async (database) => {
    await database.exec('CREATE TABLE messages (body text NOT NULL)');
    await database.query('INSERT INTO messages (body) VALUES ($1)', ['hello']);
    const result = await database.query('SELECT body FROM messages');
    assert.deepEqual(result.rows, [{ body: 'hello' }]);
  });
});

test('PGlite preserves field metadata for an empty query result', async () => {
  await withDatabase(async (database) => {
    const result = await database.query('SELECT 1 AS value WHERE false');
    assert.deepEqual(result.rows, []);
    assert.equal(result.fields[0].name, 'value');
  });
});

test('PGlite rolls back a failed transaction', async () => {
  await withDatabase(async (database) => {
    await database.exec('CREATE TABLE messages (body text NOT NULL)');
    await assert.rejects(
      database.transaction(async (transaction) => {
        await transaction.query('INSERT INTO messages (body) VALUES ($1)', ['hello']);
        throw new Error('stop');
      }),
      /stop/
    );
    const result = await database.query('SELECT body FROM messages');
    assert.deepEqual(result.rows, []);
  });
});

test('PGlite creates the parent of a filesystem database', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'remotebrowser-pglite-'));
  const dataDir = path.join(temporaryDirectory, 'nested', 'pglite');
  try {
    const database = await createPgliteDatabase({ dataDir });
    await database.close();
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});
