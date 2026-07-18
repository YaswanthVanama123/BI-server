'use strict';

module.exports = {
  lineItemsTab: 'a[href="#tab_line_items"]',
  itemsTable: 'div.ht_master',
  itemName: 'td:nth-of-type(1)',
  itemDescription: 'td:nth-of-type(2)',
  itemQuantity: 'td:nth-of-type(3)',
  itemRate: 'td:nth-of-type(4)',
  itemAmount: 'td:nth-of-type(5)',
  itemClass: 'td:nth-of-type(6)',
  itemWarehouse: 'td:nth-of-type(7)',
  itemTaxCode: 'td:nth-of-type(8)',
  itemLocation: 'td:nth-of-type(9)',
  subtotal: '#inv_subtotal',
  tax: '#inv_taxtotal',
  total: '#inv_total',
  signedBy: '#txt_signedby',
  invoiceMemo: '#txt_memo',
  serviceNotes: '#txt_service_notes',
  salesTaxRate: '#txt_inv_taxrate',
  customerEmail: '#txt_email',
  customerPhone: '#txt_phone',
};
