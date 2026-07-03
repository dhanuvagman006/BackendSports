const { Pool } = require('pg');
const config = require('./index');

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

// Without this, an error on an idle client (e.g. the DB restarting) is an
// unhandled 'error' event and crashes the whole process.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected postgres pool error', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  /** Run fn inside a transaction; rolls back on throw. */
  tx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
  pool,
};
