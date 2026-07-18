'use strict';

const { connectDatabase, disconnectDatabase, getSourceDb } = require('../src/config/database');
const env = require('../src/config/env');

(async () => {
  await connectDatabase();
  const db = getSourceDb();
  const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
  console.log(`\nsource DB: ${env.sourceDbName} — ${cols.length} collections\n`);
  for (const n of cols) {

    const count = await db.collection(n).estimatedDocumentCount();
    console.log(`  ${String(count).padStart(8)}  ${n}`);
  }
  const rs = cols.filter((n) => n.toLowerCase().includes('routestar'));
  console.log(`\nRouteStar collections (${rs.length}): ${rs.join(', ')}`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('inspect failed:', e.message); process.exit(1); });
