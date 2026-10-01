import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const migrate = async (database) => {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `);
  const applied = await database.query('SELECT name FROM schema_migrations');
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();

  for (const name of migrationNames) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
    await database.transaction(async (transaction) => {
      await transaction.exec(sql);
      await transaction.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [name, Date.now()]);
    });
  }
};

export { migrate };
