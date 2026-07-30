// Pricing helpers reading draft order line items from the Customer Account API.
const { fetchDraftOrder } = require('../index.js');

const LINE_ITEM_FRAGMENT = `
  fragment DraftLineItemPricing on DraftOrderLineItem {
    quantity
    discountedUnitPrice { amount currencyCode }
    originalUnitPrice { amount currencyCode }
  }
`;

function unitSavings(lineItem) {
  const original = Number(lineItem.originalUnitPrice.amount);
  const discounted = Number(lineItem.discountedUnitPrice.amount);
  return original - discounted;
}

async function totalSavings(draftOrderId) {
  const order = await fetchDraftOrder(draftOrderId);
  return order.lineItems.nodes.reduce(
    (sum, item) => sum + unitSavings(item) * item.quantity,
    0,
  );
}

module.exports = { LINE_ITEM_FRAGMENT, unitSavings, totalSavings };
