'use strict';

const { connectDatabase, disconnectDatabase, getEnviromasterDb } = require('../src/config/database');
const env = require('../src/config/env');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

(async () => {
  console.log('enviromaster source:', env.enviromaster.mongoUri ? `${env.enviromaster.dbName} (configured)` : 'NOT CONFIGURED — set ENVIROMASTER_MONGODB_URI');
  await connectDatabase();
  const db = await getEnviromasterDb();

  const recCount = await db.collection('mapdistancerecords').countDocuments();
  const custCount = await db.collection('routestarcustomers').countDocuments();
  console.log(`mapdistancerecords: ${recCount}`);
  console.log(`routestarcustomers: ${custCount}`);

  const sampleRecs = await db.collection('mapdistancerecords').find({}).limit(5).toArray();
  console.log('\nsample mapdistancerecords:');
  for (const r of sampleRecs) {
    console.log(`  customerId=${r.customerId} (${typeof r.customerId}) dest="${r.destinationCustomerName}" dist=${r.distanceMiles}`);
  }

  const custs = await db.collection('routestarcustomers')
    .find({}, { projection: { routeStarId: 1, name: 1, company: 1, address: 1, city: 1, state: 1, zipCode: 1 } }).toArray();
  const byObjId = new Map();
  const byName = new Map();
  for (const c of custs) {
    byObjId.set(String(c._id), c);
    if (norm(c.name)) byName.set(norm(c.name), c);
    if (norm(c.company) && !byName.has(norm(c.company))) byName.set(norm(c.company), c);
  }

  const records = await db.collection('mapdistancerecords')
    .find({}, { projection: { customerId: 1, destinationCustomerName: 1, distanceMiles: 1 } }).toArray();
  const pairs = new Set();
  let srcMatched = 0; let srcMissed = 0; let destMatched = 0; let destMissed = 0; let finiteDist = 0;
  for (const r of records) {
    const src = byObjId.get(String(r.customerId));
    src ? srcMatched++ : srcMissed++;
    const dest = byName.get(norm(r.destinationCustomerName));
    dest ? destMatched++ : destMissed++;
    if (Number.isFinite(r.distanceMiles)) finiteDist++;
    const fromId = src ? (src.routeStarId || String(src._id)) : String(r.customerId);
    const toId = dest ? (dest.routeStarId || String(dest._id)) : `name:${norm(r.destinationCustomerName)}`;
    if (fromId && toId && fromId !== toId) pairs.add(`${fromId}||${toId}`);
  }
  console.log('\njoin health across all records:');
  console.log(`  source customer matched: ${srcMatched} | missed: ${srcMissed}`);
  console.log(`  destination matched by name: ${destMatched} | missed: ${destMissed}`);
  console.log(`  records with a finite distance: ${finiteDist}`);
  console.log(`  => distinct source→destination pairs: ${pairs.size}`);
  console.log('\n(If source matched is 0, customerId does not line up with routestarcustomers._id — tell me the sample above.)');

  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('inspect failed:', e.message); process.exit(1); });
