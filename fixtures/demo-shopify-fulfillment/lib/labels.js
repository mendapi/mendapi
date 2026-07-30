// Status-to-label maps keyed by the Shopify Admin API's
// Order.displayFulfillmentStatus enum values.

const STATUS_LABELS = {
  FULFILLED: 'Fulfilled',
  PARTIALLY_FULFILLED: 'Partially fulfilled',
  UNFULFILLED: 'Unfulfilled',
  ON_HOLD: 'On hold',
  SCHEDULED: 'Scheduled',
};

const STATUS_PRIORITY = {
  'UNFULFILLED': 3,
  'PARTIALLY_FULFILLED': 2,
  'ON_HOLD': 1,
  'FULFILLED': 0,
};

function labelFor(status) {
  const label = STATUS_LABELS[status];
  if (!label) throw new Error(`Unmapped fulfillment status: ${status}`);
  return label;
}

function priorityFor(status) {
  return STATUS_PRIORITY[status] ?? 0;
}

module.exports = { labelFor, priorityFor, STATUS_LABELS };
