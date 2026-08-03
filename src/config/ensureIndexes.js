'use strict';
const { getSourceDb } = require('./database');
const { models } = require('../models');
const logger = require('../utils/logger');

const log = logger.child('indexes');

async function ensureSourceIndexes() {
  try {
    const coll = getSourceDb().collection('routestarinvoices');
    const specs = [
      { dateCompleted: 1 },
      { invoiceDate: 1 },
      { invoiceType: 1 },
      { status: 1 },
      { invoiceType: 1, dateCompleted: 1 },
      { status: 1, dateCompleted: 1 },
    ];
    for (const s of specs) await coll.createIndex(s);
    log.info('ensured indexes on routestarinvoices (dateCompleted, invoiceDate, invoiceType, status)');
  } catch (e) {
    log.warn(`could not create routestarinvoices indexes: ${e.message}`);
    log.warn('run these on inventory_db with a write-capable user for fast queries: db.routestarinvoices.createIndex({dateCompleted:1}); createIndex({invoiceDate:1}); createIndex({invoiceType:1}); createIndex({status:1})');
  }
  try {
    await models.CompanyDistance.collection.createIndex({ tenantId: 1, fromCompany: 1 });
    await models.CompanyDistance.collection.createIndex({ tenantId: 1, drivingMinutes: 1 });
    log.info('ensured indexes on company distances (tenantId+fromCompany, tenantId+drivingMinutes)');
  } catch (e) {
    log.warn(`could not create company-distance indexes: ${e.message}`);
  }
}

module.exports = { ensureSourceIndexes };

