'use strict';
const { mongoose } = require('../models');
const env = require('./env');
const logger = require('../utils/logger');

const log = logger.child('database');

async function connectDatabase(uri = env.mongoUri, opts = {}) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    autoIndex: env.nodeEnv !== 'production',
    maxPoolSize: 20,
    ...opts,
  });
  log.info(`connected: ${redact(uri)}`);
  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.disconnect();
  log.info('disconnected');
}

function getSourceDb(name = env.sourceDbName) {
  return mongoose.connection.useDb(name, { useCache: true });
}

let enviromasterConn = null;
async function getEnviromasterDb() {
  if (!env.enviromaster.mongoUri) {
    throw new Error('ENVIROMASTER_MONGODB_URI is not set — cannot read enviromaster-server data');
  }
  if (enviromasterConn && enviromasterConn.readyState === 1) return enviromasterConn;
  enviromasterConn = mongoose.createConnection(env.enviromaster.mongoUri, {
    autoIndex: false,
    maxPoolSize: 5,
    dbName: env.enviromaster.dbName,
  });
  await enviromasterConn.asPromise();
  log.info(`connected (source, read-only): ${redact(env.enviromaster.mongoUri)}`);
  return enviromasterConn;
}

function redact(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@]+)@/, '//$1:***@');
}

module.exports = { connectDatabase, disconnectDatabase, getSourceDb, getEnviromasterDb, mongoose };
