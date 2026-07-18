'use strict';
const { createApp } = require('./api/app');
const { connectDatabase } = require('./config/database');
const env = require('./config/env');
const logger = require('./utils/logger');

const log = logger.child('server');
const app = createApp();

const server = app.listen(env.api.port, () => {
  log.info(`BI API listening on http://localhost:${env.api.port}`);
  log.info(`health: /health   api index: /api/v1`);
  log.info(`CORS origins: ${env.api.corsOrigins.join(', ')}`);
});

connectDatabase().then(() => {

  require('./scheduler/dailyAccountFetch').start({ hour: 0, minute: 30 });
}).catch((e) => {
  log.warn(`MongoDB not connected (${e.message}).`);
  log.warn('Server is up; /api/v1 data endpoints return 503 until MONGODB_URI is reachable.');
});

function shutdown(sig) {
  log.info(`${sig} received, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
