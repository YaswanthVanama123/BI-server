'use strict';

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');

const ROUTE_HEADERS = ['route', 'routecode', 'route code', 'route #'];
const NAME_HEADERS = ['name', 'user', 'route user', 'employee', 'employee name', 'technician'];

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  if (!args.file || args.file === true) throw new Error('usage: npm run import:route-users -- --file=BI-Route-Users.csv [--as-of=2026-10-26]');
  const file = path.resolve(String(args.file));
  const parsed = Papa.parse(fs.readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true, transformHeader: (h) => String(h).trim().toLowerCase() });
  const pick = (row, names) => { for (const n of names) { const v = row[n]; if (v != null && String(v).trim()) return String(v).trim(); } return null; };
  const asOf = args['as-of'] && args['as-of'] !== true ? new Date(`${args['as-of']}T00:00:00Z`) : new Date();

  const rows = parsed.data.map((r) => ({ routeCode: (pick(r, ROUTE_HEADERS) || '').toUpperCase(), name: pick(r, NAME_HEADERS) })).filter((r) => r.routeCode && r.name);
  if (!rows.length) throw new Error(`no route/name rows found in ${file} (expected columns like "Route" and "Name")`);

  await connectDatabase();
  for (const r of rows) {
    await models.RouteUser.updateOne({ routeCode: r.routeCode }, { $set: { ...r, source: path.basename(file), asOf } }, { upsert: true });
  }
  console.log(`route users imported: ${rows.map((r) => `${r.routeCode}=${r.name}`).join(', ')}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('import:route-users failed:', e.message); process.exit(1); });
