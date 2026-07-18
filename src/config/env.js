'use strict';
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : v === 'true');

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/enviromaster_bi',

  sourceDbName: process.env.SOURCE_DB_NAME || 'inventory_db',

  enviromaster: {
    mongoUri: process.env.ENVIROMASTER_MONGODB_URI || '',
    dbName: process.env.ENVIROMASTER_DB_NAME || 'enviro_master',
  },

  reporting: {
    timezone: process.env.REPORTING_TIMEZONE || process.env.TZ || 'America/New_York',
  },

  routestar: {
    baseUrl: process.env.ROUTESTAR_BASE_URL || 'https://emnrv.routestar.online',
    username: process.env.ROUTESTAR_USERNAME,
    password: process.env.ROUTESTAR_PASSWORD,
  },

  browser: {
    headless: !(process.env.HEADLESS === 'false' && !!process.env.DISPLAY),
    timeout: num(process.env.BROWSER_TIMEOUT, 60000),
    screenshotDir: process.env.SCREENSHOT_DIR || 'screenshots/routestar',
  },

  mapbox: {

    token: process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN,
  },

  api: {
    port: num(process.env.PORT, 4000),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map((s) => s.trim()),
    defaultTenantCode: process.env.DEFAULT_TENANT_CODE || 'EM-NRV',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  debug: bool(process.env.DEBUG, false),
};

module.exports = env;
