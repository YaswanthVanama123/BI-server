'use strict';
const { mongoose } = require('../../models');
const { getSourceDb, getEnviromasterDb } = require('../../config/database');
const { buildEnvelope } = require('../lib/envelope');
const env = require('../../config/env');

const READY = ['disconnected', 'connected', 'connecting', 'disconnecting'];
function hostOf(uri) {
  const m = String(uri || '').match(/@([^/?]+)/);
  return m ? m[1] : (uri ? 'localhost' : '(not set)');
}
async function count(db, name) {
  try { return await db.collection(name).estimatedDocumentCount(); } catch { return null; }
}

async function connections(req, res) {
  const sources = [];

  const primary = {
    key: 'inventory_db',
    label: 'Inventory / RouteStar (inventory-server)',
    role: 'source (read-only) + BI writes (bi_*)',
    cluster: hostOf(env.mongoUri),
    db: env.sourceDbName,
    configured: !!env.mongoUri,
    readyState: READY[mongoose.connection.readyState] || String(mongoose.connection.readyState),
    connected: mongoose.connection.readyState === 1,
  };
  if (primary.connected) {
    try {
      const src = getSourceDb();
      primary.collections = {
        routestarinvoices: await count(src, 'routestarinvoices'),
        routestarcustomers: await count(src, 'routestarcustomers'),
      };
    } catch (e) { primary.error = e.message; }
  }
  sources.push(primary);

  const em = {
    key: 'enviro_master',
    label: 'EnviroMaster server (salesform / mapdistance)',
    role: 'source (read-only)',
    cluster: hostOf(env.enviromaster.mongoUri),
    db: env.enviromaster.dbName,
    configured: !!env.enviromaster.mongoUri,
    connected: false,
  };
  if (!em.configured) {
    em.error = 'ENVIROMASTER_MONGODB_URI not set in backend/.env';
  } else {
    try {
      const db = await getEnviromasterDb();
      em.connected = true;
      em.readyState = 'connected';
      em.collections = {
        mapdistancerecords: await count(db, 'mapdistancerecords'),
        routestarcustomers: await count(db, 'routestarcustomers'),
      };
    } catch (e) { em.error = e.message; }
  }
  sources.push(em);

  res.json(buildEnvelope(sources, { meta: { generatedAt: new Date().toISOString() } }));
}

module.exports = { connections };
