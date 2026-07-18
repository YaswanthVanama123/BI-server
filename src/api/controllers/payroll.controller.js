'use strict';
const { parseCsv } = require('../../etl/lib/csv');
const { runImport } = require('../../etl');
const adpPayroll = require('../../etl/importers/adpPayroll');
const summaryBuilder = require('../../services/analytics/rebuildSummaries');
const { buildEnvelope } = require('../lib/envelope');

async function uploadPayroll(req, res) {
  if (!req.tenant) { const e = new Error('No tenant resolved for this request.'); e.status = 400; e.code = 'NO_TENANT'; throw e; }
  if (!req.file || !req.file.buffer) { const e = new Error('No CSV uploaded (multipart field "file").'); e.status = 400; e.code = 'NO_FILE'; throw e; }

  const { rows, headers, errors } = parseCsv(req.file.buffer);
  if (!rows.length) { const e = new Error('CSV contained no data rows.'); e.status = 422; e.code = 'EMPTY_CSV'; throw e; }

  const batch = await runImport({
    tenant: req.tenant, handler: adpPayroll, rows,
    fileMeta: { fileName: req.file.originalname, fileHash: undefined, headers },
  });

  const availabilityDays = await summaryBuilder.allocateAvailability(req.tenant).catch(() => 0);

  res.json(buildEnvelope({
    fileName: req.file.originalname,
    rowsParsed: rows.length,
    headers,
    batchId: batch._id,
    status: batch.status,
    counts: batch.counts,
    availabilityDaysUpdated: availabilityDays,
    parseErrors: errors.slice(0, 5),
  }, { meta: { source: 'upload' } }));
}

module.exports = { uploadPayroll };
