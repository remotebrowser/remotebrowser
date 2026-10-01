import { consola } from 'consola/basic';
import { config } from '../config.js';
import { createPostgresDatabase } from './postgres.js';
import { migrate } from './migrate.js';

// Import PGlite lazily since it's not needed in production.
const createLocalDatabase = async (options) => {
  const { createPgliteDatabase } = await import('./pglite.js');
  return createPgliteDatabase(options);
};

let databasePromise;

// A real DATABASE_URL means production Postgres; without one, PGlite runs
// locally at pgliteDataDir. Both sides of the picker share the same
// {query, exec, transaction, close} shape, so migrate() and every model work
// unchanged either way.
const openDatabase = async () => {
  const database = config.databaseUrl
    ? await createPostgresDatabase({ connectionString: config.databaseUrl, ssl: config.databaseSsl })
    : await createLocalDatabase({ dataDir: config.pgliteDataDir });
  await migrate(database);
  consola.info('DATABASE ready', {
    'event.domain': 'database',
    'server.address': config.databaseUrl ? 'postgres' : config.pgliteDataDir
  });
  return database;
};

const getDatabase = () => (databasePromise ??= openDatabase());

const closeDatabase = async () => {
  if (!databasePromise) return;
  const database = await databasePromise;
  databasePromise = undefined;
  await database.close();
};

export { getDatabase, closeDatabase };
