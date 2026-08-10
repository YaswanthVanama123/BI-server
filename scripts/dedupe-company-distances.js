'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');
const env = require('../src/config/env');

const { CompanyDistance, Tenant } = models;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function score(d) {
  return (d.drivingMinutes != null ? 4 : 0)
    + (d.status === 'ok' || d.status === 'same_location' ? 2 : 0)
    + (d.distanceMiles != null ? 1 : 0);
}

function pickKeeper(docs) {
  return [...docs].sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    const at = new Date(b.syncedAt || 0) - new Date(a.syncedAt || 0);
    if (at !== 0) return at;
    return String(a._id).localeCompare(String(b._id));
  })[0];
}

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const apply = !!args.apply;
  await connectDatabase();

  const tenant = await Tenant.findOne({ tenantCode: env.api.defaultTenantCode });
  if (!tenant) { console.log('no tenant found'); await disconnectDatabase(); return; }

  const docs = await CompanyDistance.find(
    { tenantId: tenant._id },
    { fromCompany: 1, toCompany: 1, fromCustomerId: 1, toCustomerId: 1, drivingMinutes: 1, distanceMiles: 1, status: 1, syncedAt: 1 },
  ).lean();

  const groups = new Map();
  for (const d of docs) {
    const k = `${norm(d.fromCompany)}||${norm(d.toCompany)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }

  const dupeGroups = [...groups.values()].filter((g) => g.length > 1);
  const loserIds = [];
  for (const g of dupeGroups) {
    const keeper = pickKeeper(g);
    for (const d of g) if (String(d._id) !== String(keeper._id)) loserIds.push(d._id);
  }

  console.log(`total pairs: ${docs.length}`);
  console.log(`distinct company-name pairs: ${groups.size}`);
  console.log(`name-collision groups (>1 row, same normalized names): ${dupeGroups.length}`);
  console.log(`extra rows that would be removed: ${loserIds.length}`);

  dupeGroups.slice(0, 20).forEach((g) => {
    const keeper = pickKeeper(g);
    console.log(`  • ${g[0].fromCompany} → ${g[0].toCompany}  (${g.length} rows; keep ${keeper.status}/${keeper.drivingMinutes ?? 'null'}min)`);
  });

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply to remove the extra rows.');
  } else if (loserIds.length) {
    let removed = 0;
    for (let i = 0; i < loserIds.length; i += 1000) {
      const r = await CompanyDistance.deleteMany({ _id: { $in: loserIds.slice(i, i + 1000) } });
      removed += r.deletedCount || 0;
    }
    console.log(`\nAPPLIED — removed ${removed} duplicate rows.`);
  } else {
    console.log('\nNothing to remove — no duplicates found.');
  }

  await disconnectDatabase();
})().catch((e) => { console.error(e); process.exit(1); });
