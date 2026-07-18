'use strict';
const { runImport, dqIssue } = require('./importBatchRunner');
const routestarClosedInvoices = require('./importers/routestarClosedInvoices');
const inventoryCustomers = require('./importers/inventoryCustomers');
const inventoryClosedInvoices = require('./importers/inventoryClosedInvoices');
const inventoryRoutes = require('./importers/inventoryRoutes');
const inventoryItems = require('./importers/inventoryItems');
const inventoryPricing = require('./importers/inventoryPricing');
const adpPayroll = require('./importers/adpPayroll');
const inventoryDb = require('./sources/inventoryDb');

module.exports = {
  runImport,
  dqIssue,
  importers: {
    routestarClosedInvoices, inventoryCustomers, inventoryClosedInvoices,
    inventoryRoutes, inventoryItems, inventoryPricing, adpPayroll,
  },
  sources: { inventoryDb },
};
