import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const normalize = (result) => ({
  rows: result.rows || [],
  rowCount: result.affectedRows || 0,
  fields: result.fields || []
});

const createPgliteDatabase = async ({ dataDir }) => {
  if (!/^[a-z]+:\/\//i.test(dataDir)) {
    await mkdir(path.dirname(dataDir), { recursive: true });
  }
  const pglite = await PGlite.create(dataDir);

  return {
    // The raw instance, for consumers that need PGlite's own API rather than the
    // app's query/exec/transaction shape (pg-boss adapts it via fromPglite).
    pglite,
    query: async (sql, parameters = []) => normalize(await pglite.query(sql, parameters)),
    exec: async (sql) => {
      const results = await pglite.exec(sql);
      return normalize(results.at(-1) || {});
    },
    transaction: (callback) =>
      pglite.transaction((transaction) =>
        callback({
          query: async (sql, parameters = []) => normalize(await transaction.query(sql, parameters)),
          exec: async (sql) => {
            const results = await transaction.exec(sql);
            return normalize(results.at(-1) || {});
          }
        })
      ),
    close: () => pglite.close()
  };
};

export { createPgliteDatabase };
