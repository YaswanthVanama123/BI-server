'use strict';
const selectors = require('../selectors');

const MAPPING = {
  invoiceNumber: { sel: selectors.closedInvoicesList.invoiceNumber },
  invoiceHref: { sel: selectors.closedInvoicesList.invoiceLink, attr: 'href' },
  invoiceDate: { sel: selectors.closedInvoicesList.invoiceDate },
  enteredBy: { sel: selectors.closedInvoicesList.enteredBy },
  assignedTo: { sel: selectors.closedInvoicesList.assignedTo },
  customerName: { sel: selectors.closedInvoicesList.customerName },
  customerHref: { sel: selectors.closedInvoicesList.customerLink, attr: 'href' },
  invoiceType: { sel: selectors.closedInvoicesList.invoiceType },
  serviceNotes: { sel: selectors.closedInvoicesList.serviceNotes },
  status: { sel: selectors.closedInvoicesList.status },
  isComplete: { sel: selectors.closedInvoicesList.complete, checkbox: true },
  isPosted: { sel: selectors.closedInvoicesList.posted, checkbox: true },
  subtotal: { sel: selectors.closedInvoicesList.subtotal, money: true },
  invoiceTotal: { sel: selectors.closedInvoicesList.invoiceTotal, money: true },
  dateCompleted: { sel: selectors.closedInvoicesList.dateCompleted },
  lastModified: { sel: selectors.closedInvoicesList.lastModified },
  arrivalTime: { sel: selectors.closedInvoicesList.arrivalTime },
  departureTime: { sel: selectors.closedInvoicesList.departureTime },
  elapsedTime: { sel: selectors.closedInvoicesList.elapsedTime },
  customerGrouping: { sel: selectors.closedInvoicesList.customerGrouping },
  postedBy: { sel: selectors.closedInvoicesList.postedBy },
  postedTimestamp: { sel: selectors.closedInvoicesList.postedTimestamp },
  paymentMethod: { sel: selectors.closedInvoicesList.paymentMethod },
};

function customerIdFromHref(href) {
  if (!href) return '';
  const m = String(href).match(/customerdetail\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

function toRawPayload(r, session) {
  return {
    'Invoice #': r.invoiceNumber || '',
    'Invoice Date': r.invoiceDate || '',
    'Entered By': r.enteredBy || '',
    'Assigned To': r.assignedTo || '',
    Customer: r.customerName || '',
    'Customer ID': customerIdFromHref(r.customerHref),
    'Account #': '',
    Route: '',
    'Invoice Type': r.invoiceType || '',
    'Service Notes': r.serviceNotes || '',
    Status: r.status || '',
    Complete: r.isComplete ? 'Yes' : 'No',
    Posted: r.isPosted ? 'Yes' : 'No',
    Subtotal: r.subtotal || '',
    Total: r.invoiceTotal || '',
    'Date Completed': r.dateCompleted || '',
    'Last Modified': r.lastModified || '',
    'Arrival Time': r.arrivalTime || '',
    'Departure Time': r.departureTime || '',
    'Elapsed Time': r.elapsedTime || '',
    'Customer Grouping': r.customerGrouping || '',
    'Posted By': r.postedBy || '',
    'Posted Timestamp': r.postedTimestamp || '',
    'Payment Method': r.paymentMethod || '',
    _customerLink: session.absoluteUrl(r.customerHref),
    _detailUrl: session.absoluteUrl(r.invoiceHref),
  };
}

module.exports = { MAPPING, customerIdFromHref, toRawPayload };
