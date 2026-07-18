'use strict';
const mongoose = require('mongoose');

const Tenant = require('./tenant.model');
const customer = require('./customer.models');
const pricing = require('./pricing.models');
const employee = require('./employee.models');
const route = require('./route.models');
const operations = require('./operations.models');
const mapbox = require('./mapbox.models');
const cost = require('./cost.models');
const governance = require('./governance.models');
const analytics = require('./analytics.models');
const customerAccount = require('./customerAccount.models');
const sync = require('./sync.models');

const models = {
  Tenant,
  ...customer,
  ...pricing,
  ...employee,
  ...route,
  ...operations,
  ...mapbox,
  ...cost,
  ...governance,
  ...analytics,
  ...customerAccount,
  ...sync,
};

async function syncIndexes() {
  await Promise.all(Object.values(models).map((m) => m.syncIndexes()));
}

module.exports = { mongoose, syncIndexes, models };
