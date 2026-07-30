// Negative controls for the legacy card iin pack.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

// Referenced destructured bindings are never rewritten: iin is used again
// below, so the AST-track pass must leave the whole pattern alone.
async function destructured(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const { iin, brand } = customer.default_source;
  return { iin, brand };
}

// Binding declarations are kept so downstream references never become
// ReferenceErrors.
async function bound(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const binPrefix = customer.default_source.iin;
  return binPrefix ? String(binPrefix).length : 0;
}

// Comment mentions survive: card.iin was the BIN read before v2349.
module.exports = { destructured, bound };
