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
    accountFetch: {
      all: bool(process.env.ACCOUNT_FETCH_ALL, false),
      hour: num(process.env.ACCOUNT_FETCH_HOUR, 0),
      minute: num(process.env.ACCOUNT_FETCH_MINUTE, 30),
      onStart: bool(process.env.ACCOUNT_FETCH_ON_START, false),
    },
  },

  browser: {
    headless: process.env.HEADLESS !== 'false',
    timeout: num(process.env.BROWSER_TIMEOUT, 60000),
    screenshotDir: process.env.SCREENSHOT_DIR || 'screenshots/routestar',
  },

  mapbox: {

    token: process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN,
  },

  api: {
    port: num(process.env.PORT, 4000),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5174,http://localhost:4173')
      .split(',').map((s) => s.trim()).filter(Boolean),
    defaultTenantCode: process.env.DEFAULT_TENANT_CODE || 'EM-NRV',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  debug: bool(process.env.DEBUG, false),

  auth: {
    secret: process.env.AUTH_SECRET || 'enviromaster-bi-dev-secret-change-me',
    tokenTtlSec: num(process.env.AUTH_TOKEN_TTL_SEC, 7 * 24 * 3600),
  },
};

module.exports = env;
