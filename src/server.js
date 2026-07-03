const app = require('./app');
const config = require('./config');
const db = require('./config/db');

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`SportyQo API listening on :${config.port} (${config.env})`);
});

// Graceful shutdown: stop accepting connections, then drain the DB pool.
const shutdown = (signal) => {
  // eslint-disable-next-line no-console
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
  // Hard exit if something hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
