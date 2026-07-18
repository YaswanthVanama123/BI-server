'use strict';

class RouteStarNavigator {
  constructor(session) {
    this.session = session;
    this.config = session.config;
  }

  url(routeKey, suffix = '') {
    return this.config.baseUrl + this.config.routes[routeKey] + suffix;
  }

  async openClosedInvoices() {
    await this.session.openGrid(this.url('closedInvoices'), 'closed-invoices');
  }

  async openInvoices() {
    await this.session.openGrid(this.url('invoices'), 'invoices');
  }

  async openCustomers() {
    await this.session.openGrid(this.url('customers'), 'customers');
  }

  async openItems() {
    await this.session.openGrid(this.url('items'), 'items');
  }

  async gotoInvoiceDetail(invoiceNumber) {
    await this.session.goto(this.url('invoiceDetail', invoiceNumber));
    await this.session.page.waitForTimeout(2000);
  }

  async gotoCustomerDetail(customerId) {
    await this.session.goto(this.url('customerDetail', customerId));
    await this.session.page.waitForTimeout(2000);
  }

  async nextPage() {
    return this.session.goToNextPage();
  }
}

module.exports = RouteStarNavigator;
