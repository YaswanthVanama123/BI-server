'use strict';
const BrowserSession = require('./BrowserSession');
const RouteStarNavigator = require('./RouteStarNavigator');
const { fetchClosedInvoices } = require('./fetchers/closedInvoices.fetcher');
const { fetchCustomerAccounts } = require('./fetchers/customerAccounts.fetcher');
const logger = require('../../utils/logger');

class RouteStarService {
  constructor(opts = {}) {
    this.session = new BrowserSession(opts);
    this.navigator = new RouteStarNavigator(this.session);
    this.log = logger.child('routestar:service');
    this.opened = false;
  }

  async open() {
    if (this.opened) return;
    await this.session.init();
    await this.session.login();
    this.opened = true;
  }

  async close() {
    await this.session.close();
    this.opened = false;
  }

  async fetchClosedInvoices(opts = {}) {
    if (!this.opened) await this.open();
    return fetchClosedInvoices({ session: this.session, navigator: this.navigator }, opts);
  }

  async fetchCustomerAccounts(opts = {}) {
    if (!this.opened) await this.open();
    return fetchCustomerAccounts({ session: this.session, navigator: this.navigator }, opts);
  }

  async run(task) {
    try {
      await this.open();
      return await task({ session: this.session, navigator: this.navigator, service: this });
    } finally {
      await this.close();
    }
  }
}

module.exports = RouteStarService;
