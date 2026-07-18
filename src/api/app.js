'use strict';
const express = require('express');
const cors = require('cors');
const { mongoose } = require('../models');
const env = require('../config/env');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const apiRoutes = require('./routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: env.api.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger);

  app.get('/health', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(200).json({ status: 'ok', db: dbUp ? 'connected' : 'disconnected', uptimeSec: Math.round(process.uptime()) });
  });

  app.use('/api/v1', apiRoutes);

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
