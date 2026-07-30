// Demo billing reconciliation reading Stripe payment records. In v2183
// the payment-record projection of boleto relaxed tax_id to nullable,
// so any further dereference of the field must be null-guarded.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function normalizeTaxId(id) {
  const rec = await stripe.paymentRecords.retrieve(id);
  // Dereference on a possibly-null field: must gain an optional chain.
  const taxId = rec.payment_method_details.boleto.tax_id.trim();
  const compact = rec.payment_method_details.boleto.tax_id.replace(/\D/g, '');
  return { taxId, compact };
}

async function listAttemptDocs() {
  const page = await stripe.paymentAttemptRecords.list({ limit: 10 });
  return page.data.map((r) => ({
    doc: r.payment_method_details.boleto.tax_id.slice(0, 4),
    amount: r.amount,
  }));
}

async function hasTaxId(id) {
  const rec = await stripe.paymentRecords.retrieve(id);
  // Bare reads and comparisons are already null-safe: left untouched.
  if (rec.payment_method_details.boleto.tax_id === null) return false;
  const raw = rec.payment_method_details.boleto.tax_id;
  return Boolean(raw);
}

module.exports = { normalizeTaxId, listAttemptDocs, hasTaxId };
