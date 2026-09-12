'use strict';

const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };

function toMinutes(s) {
  const m = String(s || '').trim().toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h * 60 + mi;
}

function parseTs(str, dk) {
  const s = clean(str);
  if (!s) return null;
  if (/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      if (!dk) return d.getTime();
      const base = new Date(`${dk}T00:00:00`).getTime();
      const diffDays = (d.getTime() - base) / 86400000;
      if (diffDays >= -0.5 && diffDays <= 1.5) return d.getTime();
      return null;
    }
  }
  const mins = toMinutes(s);
  if (mins == null || !dk) return null;
  return new Date(`${dk}T00:00:00`).getTime() + mins * 60000;
}

function signedMinutesBetween(fromTs, toTs) {
  if (fromTs == null || toTs == null) return null;
  return Math.round((toTs - fromTs) / 60000);
}

function minutesBetween(fromTs, toTs) {
  const m = signedMinutesBetween(fromTs, toTs);
  return m == null || m < 0 ? null : m;
}

module.exports = { toMinutes, parseTs, minutesBetween, signedMinutesBetween };
