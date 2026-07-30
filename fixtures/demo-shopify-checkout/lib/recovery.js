// Cart-recovery helpers built on Customer Account API queries.
const { fetchCustomer } = require('../index.js');

// Inline single-line selection plus a bare sibling-style selection below.
const RECOVERY_QUERY = `
  query RecoveryCandidates {
    customer {
      id
      lastIncompleteCheckout { id totalPrice { amount } }
      emailAddress {
        emailAddress
      }
    }
  }
`;

const FLAGS_QUERY = `
  query CustomerFlags {
    customer {
      id
      lastIncompleteCheckout
      tags
    }
  }
`;

async function hasRecoverableCart(token) {
  const customer = await fetchCustomer(token);
  return Boolean(customer && customer.tags.includes('recovery'));
}

module.exports = { RECOVERY_QUERY, FLAGS_QUERY, hasRecoverableCart };
