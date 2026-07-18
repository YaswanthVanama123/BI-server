'use strict';
const Papa = require('papaparse');

function parseCsv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const res = Papa.parse(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return { rows: res.data || [], headers: res.meta.fields || [], errors: res.errors || [] };
}

module.exports = { parseCsv };
