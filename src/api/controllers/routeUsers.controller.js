'use strict';
const { buildEnvelope } = require('../lib/envelope');
const { models } = require('../../models');

async function list(req, res) {
  const rows = await models.RouteUser.find({}, { _id: 0, routeCode: 1, name: 1, source: 1, asOf: 1 }).sort({ routeCode: 1 }).lean();
  res.json(buildEnvelope(rows, { meta: { note: 'Current RouteStar route users. This does not prove who performed past work on an invoice.' } }));
}

module.exports = { list };
