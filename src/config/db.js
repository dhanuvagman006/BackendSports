const { Pool } = require('pg');
const config = require('./index');

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

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
