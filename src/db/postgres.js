import pg from 'pg';

const { Pool } = pg;

// node-postgres returns int8 as a string by default; the whole app treats ids
// and millisecond timestamps as numbers, and both stay well under 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const normalize = (result) => ({
  rows: result.rows || [],
  rowCount: result.rowCount ?? 0,
  fields: result.fields || []
});

const createPostgresDatabase = async ({ connectionString, ssl }) => {
  const pool = new Pool({ connectionString, ssl, max: 5 });
  // Fail at boot, not on the first request.
  await pool.query('SELECT 1');

  return {
    query: async (sql, parameters = []) => normalize(await pool.query(sql, parameters)),
    // No parameters: the simple query protocol, which also runs multi-statement
    // SQL bodies like the migration files.
    exec: async (sql) => normalize(await pool.query(sql)),
    transaction: async (callback) => {
      // A transaction needs one held connection for its whole lifetime; pool.query()
      // alone would check out a different connection per call.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({
          query: async (sql, parameters = []) => normalize(await client.query(sql, parameters)),
          exec: async (sql) => normalize(await client.query(sql))
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
};

export { createPostgresDatabase };
