'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');

function recordHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object' && !(o instanceof Date)) {
    return Object.keys(o).sort().reduce((a, k) => {
      const v = o[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') a[k] = sortKeys(v);
      return a;
    }, {});
  }
  if (typeof o === 'string') return o.trim();
  return o;
}

function coordHash(lng, lat) {
  const r = (n) => Number(n).toFixed(5);
  return crypto.createHash('sha256').update(`${r(lng)},${r(lat)}`).digest('hex');
}

function toMoney(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const s = typeof v === 'number' ? v.toFixed(4) : String(v).replace(/[$,\s]/g, '').trim();
  if (s === '' || Number.isNaN(Number(s))) return undefined;
  return mongoose.Types.Decimal128.fromString(s);
}
function moneyToNum(d) { return d == null ? 0 : Number(d.toString()); }

function parseLocalDateTime(dateStr, timeStr, timezone) {
  if (!dateStr) return { utc: undefined, local: undefined };
  const [m, d, y] = dateStr.split('/').map((x) => parseInt(x, 10));
  let hh = 0, mm = 0;
  if (timeStr) {
    const t = timeStr.trim().toUpperCase();
    const match = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
    if (match) {
      hh = parseInt(match[1], 10); mm = parseInt(match[2], 10);
      if (match[3] === 'PM' && hh < 12) hh += 12;
      if (match[3] === 'AM' && hh === 12) hh = 0;
    }
  }
  const local = `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00`;
  const utc = zonedWallClockToUtc(y, m, d, hh, mm, timezone);
  return { utc, local };
}

function zonedWallClockToUtc(y, mo, d, h, mi, timezone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const offsetMin = tzOffsetMinutes(guess, timezone);
  return new Date(guess.getTime() - offsetMin * 60000);
}
function tzOffsetMinutes(date, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function periodKeys(utcDate, timezone) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, mo, d] = dtf.format(utcDate).split('-');
  const dateKey = `${y}-${mo}-${d}`;
  const monthKey = `${y}-${mo}`;
  const isoWeek = isoWeekKey(new Date(`${dateKey}T00:00:00Z`));
  return { dateKey, monthKey, isoWeek };
}
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function diffMinutes(later, earlier) {
  if (!later || !earlier) return undefined;
  return (later.getTime() - earlier.getTime()) / 60000;
}

module.exports = {
  recordHash, sortKeys, coordHash, toMoney, moneyToNum,
  parseLocalDateTime, zonedWallClockToUtc, periodKeys, diffMinutes, pad,
};
