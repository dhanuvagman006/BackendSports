const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`SportyQo API listening on :${config.port} (${config.env})`);
});
