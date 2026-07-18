'use strict';
const env = require('./config/env');
const { connectDatabase, disconnectDatabase, mongoose } = require('./config/database');
const { models, syncIndexes } = require('./models');
const etl = require('./etl');
const services = require('./services');
const automation = require('./automation/routestar');
const logger = require('./utils/logger');
const { createApp } = require('./api/app');

module.exports = {
  env,
  logger,
  mongoose,
  connectDatabase,
  disconnectDatabase,
  models,
  syncIndexes,
  etl,
  services,
  automation,
  RouteStarService: automation.RouteStarService,
  createApp,
};
