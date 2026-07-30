// Demo payments service reading Stripe payment intents. The settlement
// speed preference field was withdrawn upstream in v2154 (request
// schemas reject unknown props), so the property must be deleted from
// payloads and every read of it removed.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function createIntent(amount) {
  return stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: { preferred_settlement_speed: 'fastest', verification_method: 'automatic' },
    },
  });
}

async function auditIntent(id) {
  const pi = await stripe.paymentIntents.retrieve(id);
  const opts = pi.payment_method_options.us_bank_account;
  const { preferred_settlement_speed, verification_method } = opts;
  const summary = {
    verification: verification_method,
    fast: preferred_settlement_speed === 'fastest',
  };
  return summary;
}

module.exports = { createIntent, auditIntent };
