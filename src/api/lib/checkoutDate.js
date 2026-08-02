'use strict';

function fromWallClock(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function filterDayKey(inv) {
  if (!inv) return null;
  return fromWallClock(inv.departureTime) || fromWallClock(inv.arrivalTime) || fromDate(inv.dateCompleted);
}

function inFilterRange(inv, from, to) {
  if (!from && !to) return true;
  const dk = filterDayKey(inv);
  if (!dk) return false;
  const lo = from || to;
  const hi = to || from;
  return dk >= lo && dk <= hi;
}

module.exports = { filterDayKey, inFilterRange };
