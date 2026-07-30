// Guard negative site: an FX rate table keyed by ISO currency codes.
// There is no tipping surface anywhere in this file, so even though the
// service imports stripe for unrelated payment work, the bgn entries
// below must stay byte-identical.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

const FX_RATES = {
  bgn: 0.5113,
  eur: 1.0,
  usd: 1.08,
};

function convertToEur(amount, currency) {
  const rate = FX_RATES[currency];
  if (!rate) throw new Error(`unknown currency ${currency}`);
  return amount * rate;
}

async function chargeInEur(customerId, amount, currency) {
  const eurAmount = Math.round(convertToEur(amount, currency) * 100);
  return stripe.charges.create({ customer: customerId, amount: eurAmount, currency: 'eur' });
}

module.exports = { convertToEur, chargeInEur, FX_RATES };
