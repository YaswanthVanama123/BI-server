'use strict';

function getPaging(query = {}, { defaultPageSize = 50, maxPageSize = 500, safetyCap = 5000 } = {}) {
  const hasParams = (query.page != null && query.page !== '') || (query.pageSize != null && query.pageSize !== '');
  const all = !hasParams || String(query.pageSize) === 'all';
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = all ? null : Math.min(maxPageSize, Math.max(1, parseInt(query.pageSize, 10) || defaultPageSize));
  return {
    all,
    hasParams,
    page,
    pageSize,
    skip: all ? 0 : (page - 1) * pageSize,
    limit: all ? safetyCap : pageSize,
  };
}

function pageMeta(total, paging, returned) {
  if (paging.all) return { page: 1, pageSize: returned, total, totalPages: 1 };
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / paging.pageSize)),
  };
}

function sliceArray(rows, paging) {
  if (paging.all) return rows.slice(0, paging.limit);
  return rows.slice(paging.skip, paging.skip + paging.pageSize);
}

module.exports = { getPaging, pageMeta, sliceArray };
