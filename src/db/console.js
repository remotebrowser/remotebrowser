import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDatabase, closeDatabase } from './database.js';

const TABLES_SQL = `
  SELECT schemaname, tablename
  FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY schemaname, tablename
`;

const executeConsoleCommand = async (database, command) => {
  const sql = command.trim();
  if (['.exit', '.quit', '\\q'].includes(sql)) return { exit: true };
  return { result: await database.query(sql === '.tables' ? TABLES_SQL : sql) };
};

const runConsole = async () => {
  const database = await getDatabase();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.on('SIGINT', () => readline.close());
  if (config.databaseUrl) {
    console.log('Postgres: connected via DATABASE_URL');
  } else {
    console.log(`PGlite: ${config.pgliteDataDir}`);
    console.log('Stop the development server before using this console. Enter .tables, .quit, or SQL.');
  }

  try {
    while (true) {
      let command;
      try {
        command = await readline.question('db> ');
      } catch {
        break;
      }
      if (!command.trim()) continue;
      try {
        const outcome = await executeConsoleCommand(database, command);
        if (outcome.exit) break;
        if (outcome.result.rows.length > 0) console.table(outcome.result.rows);
        else if (outcome.result.fields.length > 0) console.log('(0 rows)');
        else console.log(`OK (${outcome.result.rowCount} rows affected)`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    readline.close();
    await closeDatabase();
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runConsole();
}

export { executeConsoleCommand, runConsole };
