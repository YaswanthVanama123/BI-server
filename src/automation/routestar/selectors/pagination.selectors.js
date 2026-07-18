'use strict';

module.exports = {
  listItems: '.pagination li, .paginationjs li, [class*="pagination"] li',
  nextButton: '.pagination li.next',
  nextCandidates: '.pagination li.next, .pagination li[class*="next"]',
  activePage: '.pagination li.active',
  numberedPages: '.pagination li:not(.prev):not(.next):not(.active)',
  modalDialog: '.jconfirm',
  modalCancel: '.jconfirm button:has-text("CANCEL"), .jconfirm .btn-default',
};
