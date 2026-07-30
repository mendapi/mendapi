// Guard negative site for the AST-track pass: bgn is bound from a plain
// per-currency rounding preset map, not from the Stripe tipping surface.
// The file imports stripe AND mentions tipping (so the file-level guards
// pass), which makes the anchor gate the only thing standing between the
// pack and an unrelated dead binding — the whole file must stay
// byte-identical.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

const roundingPresets = { bgn: 2, eur: 2, usd: 2 };

function roundingFor() {
  const { bgn, eur } = roundingPresets;
  return eur;
}

async function tippingEnabled(id) {
  const cfg = await stripe.terminal.configurations.retrieve(id);
  return Boolean(cfg.tipping);
}

module.exports = { roundingFor, tippingEnabled, roundingPresets };
