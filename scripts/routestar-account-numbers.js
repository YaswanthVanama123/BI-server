'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { fetchMissingAccounts } = require('../src/services/routestar/accountFetch');

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  await connectDatabase();
  const r = await fetchMissingAccounts({
    all: !!args.all,
    limit: args.limit ? Number(args.limit) : undefined,
    batchSize: args.batch ? Number(args.batch) : 5,
  });
  console.log(`done: ${r.stored}/${r.total} stored (${r.withAccount} with an account number).`);
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('rs:accounts failed:', e.message); process.exit(1); });
