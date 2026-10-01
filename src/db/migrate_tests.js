import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteDatabase } from './pglite.js';
import { migrate } from './migrate.js';

const withDatabase = async (callback) => {
  const database = await createPgliteDatabase({ dataDir: 'memory://' });
  try {
    await callback(database);
  } finally {
    await database.close();
  }
};

test('migrate creates the application tables once', async () => {
  await withDatabase(async (database) => {
    await migrate(database);
    await migrate(database);
    const tables = await database.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    assert.deepEqual(
      tables.rows.map((row) => row.tablename),
      ['browser_instances', 'collaborators', 'invitations', 'schema_migrations', 'signin_codes', 'users', 'workspaces']
    );
    const migrations = await database.query('SELECT name FROM schema_migrations ORDER BY name');
    assert.deepEqual(
      migrations.rows.map((row) => row.name),
      [
        '001_users.sql',
        '002_signin.sql',
        '003_workspaces.sql',
        '004_collaborators.sql',
        '005_browser_instances.sql',
        '006_users_public_id.sql',
        '007_workspaces_public_id.sql',
        '008_browser_instances_public_id.sql'
      ]
    );
  });
});

test('initial schema enforces one personal workspace per user', async () => {
  await withDatabase(async (database) => {
    await migrate(database);
    const user = await database.query(`INSERT INTO users (email, public_id) VALUES ($1, $2) RETURNING id`, [
      'user@example.com',
      'abcdefghi'
    ]);
    const ownerId = user.rows[0].id;
    await database.query(
      `INSERT INTO workspaces (name, owner_id, personal, public_id) VALUES ('Personal', $1, true, $2)`,
      [ownerId, 'Wabc234']
    );
    await assert.rejects(
      database.query(`INSERT INTO workspaces (name, owner_id, personal, public_id) VALUES ('Personal', $1, true, $2)`, [
        ownerId,
        'Wdef567'
      ]),
      /unique/i
    );
  });
});

test('users.public_id is unique and required', async () => {
  await withDatabase(async (database) => {
    await migrate(database);
    await database.query(`INSERT INTO users (email, public_id) VALUES ($1, $2)`, ['a@example.com', 'abcdefghi']);
    await assert.rejects(
      database.query(`INSERT INTO users (email, public_id) VALUES ($1, $2)`, ['b@example.com', 'abcdefghi']),
      /unique/i
    );
    await assert.rejects(database.query(`INSERT INTO users (email) VALUES ($1)`, ['c@example.com']), /null/i);
  });
});

test('workspaces.public_id is unique and required', async () => {
  await withDatabase(async (database) => {
    await migrate(database);
    const user = await database.query(`INSERT INTO users (email, public_id) VALUES ($1, $2) RETURNING id`, [
      'owner@example.com',
      'abcdefghi'
    ]);
    const ownerId = user.rows[0].id;
    await database.query(`INSERT INTO workspaces (name, owner_id, public_id) VALUES ($1, $2, $3)`, [
      'Team',
      ownerId,
      'Wabc234'
    ]);
    await assert.rejects(
      database.query(`INSERT INTO workspaces (name, owner_id, public_id) VALUES ($1, $2, $3)`, [
        'Other',
        ownerId,
        'Wabc234'
      ]),
      /unique/i
    );
    await assert.rejects(
      database.query(`INSERT INTO workspaces (name, owner_id) VALUES ($1, $2)`, ['NoId', ownerId]),
      /null/i
    );
  });
});

test('browser_instances.public_id is unique and required', async () => {
  await withDatabase(async (database) => {
    await migrate(database);
    const user = await database.query(`INSERT INTO users (email, public_id) VALUES ($1, $2) RETURNING id`, [
      'owner@example.com',
      'abcdefghi'
    ]);
    const ownerId = user.rows[0].id;
    const workspace = await database.query(
      `INSERT INTO workspaces (name, owner_id, public_id) VALUES ($1, $2, $3) RETURNING id`,
      ['Team', ownerId, 'Wabc234']
    );
    const workspaceId = workspace.rows[0].id;
    await database.query(
      `INSERT INTO browser_instances (workspace_id, user_id, browser_name, status, browser_handle, public_id)
       VALUES ($1, $2, $3, 'starting', $4, $5)`,
      [workspaceId, ownerId, 'calm-otter', 'handle-1', 'Babc234']
    );
    await assert.rejects(
      database.query(
        `INSERT INTO browser_instances (workspace_id, user_id, browser_name, status, browser_handle, public_id)
         VALUES ($1, $2, $3, 'starting', $4, $5)`,
        [workspaceId, ownerId, 'brave-otter', 'handle-2', 'Babc234']
      ),
      /unique/i
    );
    await assert.rejects(
      database.query(
        `INSERT INTO browser_instances (workspace_id, user_id, browser_name, status, browser_handle)
         VALUES ($1, $2, $3, 'starting', $4)`,
        [workspaceId, ownerId, 'no-id', 'handle-3']
      ),
      /null/i
    );
  });
});
