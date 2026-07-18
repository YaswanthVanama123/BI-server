'use strict';
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function itemKey(s) { const t = norm(s); const i = t.lastIndexOf(':'); return i >= 0 ? t.slice(i + 1).trim() : t; }

function frequencyFor(line, pricing) {
  if (!pricing || !pricing.length) return null;
  const name = itemKey(line.name || line.item);
  const desc = norm(line.description);
  const rate = Number(line.rate != null ? line.rate : line.salesPrice);
  const byName = pricing.filter((p) => {
    const pk = itemKey(p.item);
    return (name && pk === name) || (desc && norm(p.description) === desc);
  });
  const pool = byName.length ? byName : [];
  let m = pool.find((p) => p.salesPrice != null && Number.isFinite(rate) && Math.abs(Number(p.salesPrice) - rate) < 0.01);
  if (!m && pool.length) m = pool[0];
  return m ? (m.frequency || null) : null;
}

module.exports = { frequencyFor, itemKey, norm };
