// Demo app: renders order badges from the Shopify Admin API.
// Reads Order.displayFulfillmentStatus and branches exhaustively on it.
const fetchJson = (url, opts) => fetch(url, opts).then((r) => r.json());

async function getOrderStatus(shop, token, orderId) {
  const data = await fetchJson(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query Order($id: ID!) {
        order(id: $id) {
          id
          displayFulfillmentStatus
        }
      }`,
      variables: { id: orderId },
    }),
  });
  return data.data.order.displayFulfillmentStatus;
}

// Exhaustive switch over the fulfillment status enum.
function badgeFor(status) {
  switch (status) {
    case 'FULFILLED':
      return { tone: 'success', label: 'Fulfilled' };
    case 'PARTIALLY_FULFILLED':
      return { tone: 'warning', label: 'Partially fulfilled' };
    case 'UNFULFILLED':
      return { tone: 'attention', label: 'Unfulfilled' };
    case 'ON_HOLD':
      return { tone: 'info', label: 'On hold' };
    case 'SCHEDULED':
      return { tone: 'info', label: 'Scheduled' };
    default:
      throw new Error(`Unknown fulfillment status: ${status}`);
  }
}

module.exports = { getOrderStatus, badgeFor };
