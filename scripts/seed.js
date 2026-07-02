/* Runs seeds/*.sql in order. Safe to re-run (seeds use ON CONFLICT DO NOTHING). */
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

(async () => {
  const dir = path.join(__dirname, '..', 'seeds');
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    console.log('Seeding', file);
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  console.log('Seed complete');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
