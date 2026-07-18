'use strict';
const { models } = require('../../models');
const { clean, norm, sourceStage } = require('./_shared');

const { ServiceItem, ServiceCategory, ItemCategoryMapping } = models;

const cache = { catByCode: null, unmappedId: null };

function toCategoryCode(row) {
  const s = `${row.category || ''} ${row.type || ''} ${row.grouping || ''} ${row.department || ''} ${row.itemName || ''}`.toLowerCase();
  if (/trip\s*charge|trip\s*fee/.test(s)) return 'TRIP_CHARGE';
  if (/drain/.test(s)) return 'DRAIN';
  if (/scrub/.test(s)) return 'SCRUB';
  if (/window/.test(s)) return 'WINDOW';
  if (/restroom|hygiene|urinal|soap|air\s*freshener|toilet|paper|dispenser/.test(s)) return 'RESTROOM_HYGIENE';
  if (/sani/.test(s)) return 'SANI';
  return 'OTHER';
}

async function loadCategories(tenantId) {
  if (cache.catByCode) return;
  cache.catByCode = new Map();
  const cats = await ServiceCategory.find({ tenantId }).lean();
  for (const c of cats) { cache.catByCode.set(c.categoryCode, c._id); if (c.isUnmapped) cache.unmappedId = c._id; }
}

module.exports = {
  name: 'inventory_items',
  sourceSystem: 'routestar',
  sourceEntity: 'item',
  rawModel: models.RawRouteStarItems,

  getSourceRecordId(row) { return `${clean(row.itemParent) || ''}::${clean(row.itemName) || ''}`; },

  async processRecord(row, ctx) {
    const { tenant, batch, now, recordHash } = ctx;
    await loadCategories(tenant._id);
    const itemCode = clean(row.itemName);
    if (!itemCode) return { syncStatus: 'rejected', curatedTouches: {}, dq: [] };

    const categoryId = cache.catByCode.get(toCategoryCode(row)) || cache.unmappedId;

    await ServiceItem.updateOne(
      { tenantId: tenant._id, itemCode },
      {
        $set: {
          tenantId: tenant._id, itemCode,
          description: clean(row.description) || itemCode,
          serviceCategoryId: categoryId,
          unitOfMeasure: clean(row.uom),
          isActive: true,
        },
        $addToSet: { sourceItemIds: itemCode },
      },
      { upsert: true },
    );

    await ItemCategoryMapping.updateOne(
      { tenantId: tenant._id, matchType: 'exact_code', matchValue: itemCode },
      { $set: { tenantId: tenant._id, matchType: 'exact_code', matchValue: itemCode, serviceCategoryId: categoryId, priority: 100, isActive: true, reviewStatus: 'approved', updatedBy: 'inventory_items_import' } },
      { upsert: true },
    );

    return { syncStatus: 'updated', curatedTouches: {}, dq: [] };
  },

  async recalcAffected() {  },
};
