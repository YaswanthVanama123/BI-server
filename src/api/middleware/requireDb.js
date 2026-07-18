'use strict';
const { mongoose } = require('../../models');

module.exports = function requireDb(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();
  return res.status(503).json({
    error: {
      code: 'DB_UNAVAILABLE',
      message: 'Database not connected. Set MONGODB_URI and ensure MongoDB is running.',
    },
  });
};
