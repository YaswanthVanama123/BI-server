'use strict';
const env = require('../../config/env');

module.exports = {
  name: 'RouteStar',
  baseUrl: env.routestar.baseUrl,

  credentials: {
    username: env.routestar.username,
    password: env.routestar.password,
  },

  routes: {
    login: '/web/login/',
    invoices: '/web/invoices/',
    closedInvoices: '/web/closedinvoices/',
    invoiceDetail: '/web/invoice/',
    items: '/web/items/',
    customers: '/web/customers/',
    customerDetail: '/web/customerdetail/',
  },

  browser: {
    headless: env.browser.headless,
    timeout: env.browser.timeout,
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },

  grid: {
    renderTimeoutMs: 300000,
    pollIntervalMs: 2000,
    dataSettleMs: 5000,
  },

  pagination: { maxPages: Infinity, pageDelay: 3000 },
  retry: { maxAttempts: 3, delay: 2000, backoff: true },
  screenshotDir: env.browser.screenshotDir,
};
