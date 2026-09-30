import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DATA_DIR = 'memory://';

const { getDatabase, closeDatabase } = await import('./database.js');

test.afterEach(async () => closeDatabase());

test('the database opens once and is shared', async () => {
  const first = await getDatabase();
  const second = await getDatabase();
  assert.equal(first, second);

  await first.exec('CREATE TABLE messages (body text NOT NULL)');
  await first.query('INSERT INTO messages (body) VALUES ($1)', ['hello']);
  const result = await second.query('SELECT body FROM messages');
  assert.deepEqual(result.rows, [{ body: 'hello' }]);
});
