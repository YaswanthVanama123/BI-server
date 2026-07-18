'use strict';
const RouteStarService = require('./RouteStarService');
const BrowserSession = require('./BrowserSession');
const RouteStarNavigator = require('./RouteStarNavigator');
const config = require('./config');
const selectors = require('./selectors');
const errors = require('./errors');
const closedInvoicesFetcher = require('./fetchers/closedInvoices.fetcher');
const closedInvoicesParser = require('./parsers/closedInvoices.parser');

module.exports = {
  RouteStarService,
  BrowserSession,
  RouteStarNavigator,
  config,
  selectors,
  ...errors,
  fetchers: { closedInvoices: closedInvoicesFetcher },
  parsers: { closedInvoices: closedInvoicesParser },
};
