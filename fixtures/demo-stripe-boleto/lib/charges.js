// Guard positive-survival site: this file reads boleto tax_id on the
// CHARGE surface, where the shared payment_method_details_boleto schema
// keeps tax_id required and non-nullable in both v2182 and v2183. No
// payment-record surface token appears here, so the null-guard mend
// must leave every line byte-identical.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function chargeTaxId(chargeId) {
  const charge = await stripe.charges.retrieve(chargeId);
  // Still guaranteed non-null on the charge surface: no guard needed.
  return charge.payment_method_details.boleto.tax_id.trim();
}

// Unrelated local object with a same-named field and no full chain:
// must never be touched either.
const invoiceProfile = {
  tax_id: 'BR-000',
  format: (p) => p.tax_id.toUpperCase(),
};

module.exports = { chargeTaxId, invoiceProfile };
