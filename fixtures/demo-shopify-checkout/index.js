// Demo storefront helper talking to the Shopify Customer Account API.
// Legacy queries still select the removed field on Customer; the mend
// deletes those selections (the whole nested block goes with the parent).
const ENDPOINT = 'https://shopify.com/12345678/account/customer/api/2025-07/graphql';

const CUSTOMER_QUERY = `
  query CustomerSummary {
    customer {
      id
      displayName
      lastIncompleteCheckout {
        id
        appliedGiftCards {
          id
          balance { amount currencyCode }
        }
        lineItems(first: 10) {
          nodes {
            title
            quantity
          }
        }
      }
      defaultAddress {
        city
        country
      }
    }
  }
`;

async function fetchCustomer(token) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: CUSTOMER_QUERY }),
  });
  const { data } = await res.json();
  return data.customer;
}

module.exports = { fetchCustomer, CUSTOMER_QUERY };
