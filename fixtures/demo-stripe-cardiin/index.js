// Demo billing analytics service reading Stripe card objects. In
// v2349 (API version 2026-07-29.dahlia) the legacy shared "card" source
// schema dropped its iin property (first-six / BIN issuer metadata) with
// no successor, so every read of .iin off a card object must be removed.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function customerCardProfile(customerId) {
  const customer = await stripe.customers.retrieve(customerId, { expand: ['default_source'] });
  const card = customer.default_source;
  const profile = {
    brand: card.brand,
    bin: card.iin,
    last4: card.last4,
  };
  if (card.iin) profile.binKnown = true;
  return profile;
}

async function listExternalAccounts(accountId) {
  const page = await stripe.accounts.listExternalAccounts(accountId, { object: 'card', limit: 10 });
  return page.data.map((c) => ({
    funding: c.funding,
    firstSix: c.iin,
    expiry: `${c.exp_month}/${c.exp_year}`,
  }));
}

async function chargeErrorCard(chargeId) {
  const charge = await stripe.charges.retrieve(chargeId);
  const source = charge.payment_intent?.last_payment_error?.source;
  if (!source) return null;
  console.log(source.iin);
  return source.brand;
}

// Dead destructured binding: iin is pulled out of the pattern and never
// referenced again, so the AST-track pass removes just that field.
async function fundingKind(customerId) {
  const customer = await stripe.customers.retrieve(customerId);
  const { iin, funding } = customer.default_source;
  return funding;
}

module.exports = { customerCardProfile, listExternalAccounts, chargeErrorCard, fundingKind };
