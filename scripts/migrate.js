/* Applies migrations/*.sql in order; tracks applied files in schema_migrations. */
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

(async () => {
  const reset = process.argv.includes('--reset');
  if (reset) {
    console.log('Dropping public schema...');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  const dir = path.join(__dirname, '..', 'migrations');
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
    if (rowCount) continue;
    console.log('Applying', file);
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
  console.log('Migrations complete');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
