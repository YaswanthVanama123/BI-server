'use strict';
const { models, mongoose } = require('../../models');
const env = require('../../config/env');

const cache = new Map();

module.exports = async function tenant(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) { req.tenant = null; req.tenantId = null; return next(); }
    const code = req.get('x-tenant-code') || req.query.tenantCode || env.api.defaultTenantCode;
    let t = cache.get(code);

    if (!t) {
      t = await models.Tenant.findOne({ tenantCode: code }).lean();
      if (t) cache.set(code, t);
    }
    req.tenant = t || null;
    req.tenantId = t ? t._id : null;
    next();
  } catch (e) {
    next(e);
  }
};

module.exports.clearCache = () => cache.clear();
