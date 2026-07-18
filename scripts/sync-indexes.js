'use strict';
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { syncIndexes } = require('../src/models');

(async () => {
  await connectDatabase();
  await syncIndexes();
  console.log('indexes built');
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => {
  console.error('sync-indexes failed:', e.message);
  process.exit(1);
});
