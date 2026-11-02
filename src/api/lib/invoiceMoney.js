'use strict';

const UNITEMIZED_KEY = '__unitemized__';
const UNITEMIZED_LABEL = 'Not matched to line items';

function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const cents = (v) => toCents(v) || 0;
const dollars = (c) => Math.round(Number(c) || 0) / 100;

function linesCents(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((t, li) => t + cents(li && li.amount), 0);
}

function netCents(inv) {
  const sub = toCents(inv && inv.subtotal);
  const total = toCents(inv && inv.total);
  if (sub !== null && !(sub === 0 && total !== null && total > 0)) return sub;
  if (total !== null) return total - cents(inv.tax);
  return linesCents(inv && inv.lineItems);
}

function grossCents(inv) {
  const total = toCents(inv && inv.total);
  if (total !== null && !(total === 0 && netCents(inv) > 0)) return total;
  return netCents(inv) + cents(inv && inv.tax);
}

function taxCents(inv) {
  return grossCents(inv) - netCents(inv);
}

function effectiveLines(inv, snap) {
  const net = netCents(inv);
  const current = snap && (cents(snap.subtotal) === net || (snap.sourceSubtotal != null && cents(snap.sourceSubtotal) === net));
  if (snap && snap.status === 'ok' && Array.isArray(snap.lineItems) && current) {
    return { lines: snap.lineItems, source: 'routestar', refreshedAt: snap.fetchedAt || null };
  }
  return { lines: (inv && inv.lineItems) || [], source: 'inventory_db', refreshedAt: null };
}

module.exports = {
  UNITEMIZED_KEY, UNITEMIZED_LABEL, toCents, cents, dollars, linesCents, netCents, grossCents, taxCents, effectiveLines,
};
