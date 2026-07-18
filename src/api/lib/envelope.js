'use strict';

function buildEnvelope(data, { meta = {}, page } = {}) {
  const base = {
    data,
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'live',
      ...meta,
    },
  };
  if (page) base.page = page;
  return base;
}

module.exports = { buildEnvelope };
