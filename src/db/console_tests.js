import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConsoleCommand } from './console.js';

test('console exits for its supported quit commands', async () => {
  const database = { query: () => assert.fail('quit must not query') };
  for (const command of ['.exit', '.quit', '\\q']) {
    assert.deepEqual(await executeConsoleCommand(database, command), { exit: true });
  }
});

test('console expands .tables into a catalog query', async () => {
  let sql;
  const database = {
    query: (value) => {
      sql = value;
      return { rows: [], rowCount: 0 };
    }
  };
  await executeConsoleCommand(database, '.tables');
  assert.match(sql, /FROM pg_tables/);
});

test('console sends SQL to PGlite unchanged apart from surrounding whitespace', async () => {
  let sql;
  const database = {
    query: (value) => {
      sql = value;
      return { rows: [{ answer: 42 }], rowCount: 0 };
    }
  };
  const outcome = await executeConsoleCommand(database, '  SELECT 42 AS answer  ');
  assert.equal(sql, 'SELECT 42 AS answer');
  assert.deepEqual(outcome.result.rows, [{ answer: 42 }]);
});
