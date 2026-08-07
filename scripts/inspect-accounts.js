'use strict';
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { models } = require('../src/models');

const { CustomerAccount } = models;

(async () => {
  await connectDatabase();
  const total = await CustomerAccount.countDocuments({});
  const withFetched = await CustomerAccount.countDocuments({ fetchedAt: { $ne: null } });
  const noFetched = await CustomerAccount.countDocuments({ $or: [{ fetchedAt: null }, { fetchedAt: { $exists: false } }] });
  const withAccount = await CustomerAccount.countDocuments({ accountNumber: { $nin: [null, ''] } });
  const withPricing = await CustomerAccount.countDocuments({ 'pricing.0': { $exists: true } });
  const withRoutes = await CustomerAccount.countDocuments({ 'routes.0': { $exists: true } });
  const withActivity = await CustomerAccount.countDocuments({ 'activity.0': { $exists: true } });
  const statusOk = await CustomerAccount.countDocuments({ status: 'ok' });
  const statusNoAcct = await CustomerAccount.countDocuments({ status: 'no_account' });
  const statusErr = await CustomerAccount.countDocuments({ status: 'error' });

  // fetched but no tab data at all (empty pricing AND routes AND activity)
  const fetchedButEmpty = await CustomerAccount.countDocuments({
    fetchedAt: { $ne: null },
    $and: [
      { $or: [{ pricing: { $exists: false } }, { pricing: { $size: 0 } }] },
      { $or: [{ routes: { $exists: false } }, { routes: { $size: 0 } }] },
      { $or: [{ activity: { $exists: false } }, { activity: { $size: 0 } }] },
    ],
  });

  console.log('=== bi_customeraccounts summary ===');
  console.log('total records        :', total);
  console.log('has fetchedAt        :', withFetched);
  console.log('NO fetchedAt (stub)  :', noFetched);
  console.log('has accountNumber    :', withAccount);
  console.log('has pricing rows     :', withPricing);
  console.log('has routes rows      :', withRoutes);
  console.log('has activity rows    :', withActivity);
  console.log('status ok/no_acct/err:', statusOk, '/', statusNoAcct, '/', statusErr);
  console.log('fetched but EMPTY tabs:', fetchedButEmpty);

  const sample = await CustomerAccount.find({}, { customerId: 1, customerName: 1, accountNumber: 1, fetchedAt: 1, status: 1, pricing: 1, routes: 1, activity: 1 }).limit(5).lean();
  console.log('\n=== sample 5 ===');
  for (const s of sample) {
    console.log(`${s.customerId} | ${s.customerName || '(no name)'} | acct=${s.accountNumber || '-'} | fetchedAt=${s.fetchedAt ? 'yes' : 'NO'} | status=${s.status} | pricing=${(s.pricing || []).length} routes=${(s.routes || []).length} activity=${(s.activity || []).length}`);
  }
  await disconnectDatabase();
  process.exit(0);
})().catch((e) => { console.error('inspect failed:', e.message); process.exit(1); });
