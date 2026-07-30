// Demo reconciliation service reading Stripe payment records. In
// v2324 the payment-record card details schema dropped four metadata
// properties (see the migration pack), so every read of them on the
// payment_records / payment_attempt_records surfaces must be removed.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function summarizeRecord(id) {
  const rec = await stripe.paymentRecords.retrieve(id);
  const summary = {
    brand: rec.payment_method_details.card.brand,
    bank: rec.payment_method_details.card.issuer,
    label: rec.payment_method_details.card.description,
    binPrefix: rec.payment_method_details.card.iin,
  };
  const recurring = rec.payment_method_details.card.stored_credential_usage === 'recurring';
  if (recurring) summary.recurring = true;
  return summary;
}

async function listAttempts() {
  const page = await stripe.paymentAttemptRecords.list({ limit: 10 });
  return page.data.map((r) => ({
    amount: r.amount,
    network: r.payment_method_details.card.network,
    firstSix: r.payment_method_details.card.iin,
  }));
}

async function auditUsage(id) {
  const rec = await stripe.paymentRecords.retrieve(id);
  console.log(rec.payment_method_details.card.stored_credential_usage);
  return rec.amount;
}

module.exports = { summarizeRecord, listAttempts, auditUsage };
