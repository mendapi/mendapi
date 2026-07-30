// Guard positive-survival site: this file talks to the Stripe Terminal
// (card-present) surface, where the same metadata field names survive
// the v2324 change. Every line here must stay byte-identical after the
// payment-record card-details mend runs — the pack only anchors on the
// payment_method_details.card.<field> chain, and card_present is a
// different segment.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function describePresentCharge(id) {
  const rec = await stripe.paymentRecords.retrieve(id);
  const present = rec.payment_method_details.card_present;
  return {
    label: present.description,
    bank: present.issuer,
    entry: rec.payment_method_details.card_present.read_method,
  };
}

// Unrelated local object using the same generic field names, with no
// payment_method_details chain: must never be touched either.
const terminalProfile = {
  description: 'Front-desk reader',
  issuer: 'internal-ops',
};

module.exports = { describePresentCharge, terminalProfile };
