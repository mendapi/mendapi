// Demo app querying the Shopify Customer Account API for draft orders.
// Shopify deprecated DraftOrderLineItem.discountedUnitPrice in favor of
// approximateDiscountedUnitPrice (approximate per-unit price reduction).
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_CUSTOMER_TOKEN;
const ENDPOINT = `https://${SHOP}/account/customer/api/2026-04/graphql`;

const DRAFT_ORDER_QUERY = `
  query DraftOrderDetails($id: ID!) {
    draftOrder(id: $id) {
      id
      lineItems(first: 50) {
        nodes {
          title
          quantity
          discountedUnitPrice {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

async function fetchDraftOrder(id) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: TOKEN,
    },
    body: JSON.stringify({ query: DRAFT_ORDER_QUERY, variables: { id } }),
  });
  if (!res.ok) throw new Error(`Customer Account API ${res.status}`);
  const json = await res.json();
  return json.data.draftOrder;
}

module.exports = { fetchDraftOrder };
