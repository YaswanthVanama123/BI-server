'use strict';
const logger = require('../../utils/logger');

const log = logger.child('api:error');

module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error(`${req.method} ${req.originalUrl}:`, err.stack || err.message);
  else log.warn(`${req.method} ${req.originalUrl}: ${err.message}`);
  res.status(status).json({
    error: {
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status >= 500 ? 'An unexpected error occurred.' : err.message,
    },
  });
};
