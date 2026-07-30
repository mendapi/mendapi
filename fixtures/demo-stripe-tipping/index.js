// Demo point-of-sale backoffice configuring Stripe Terminal tipping.
// The bgn currency block was removed upstream in v2154 (Bulgaria euro
// adoption; request schemas reject unknown props), so bgn tipping
// blocks and reads must be deleted. Bulgarian terminals move to eur.
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function createTerminalConfig() {
  return stripe.terminal.configurations.create({
    tipping: {
      bgn: { percentages: [5, 10, 15], smart_tip_threshold: 10 },
      eur: { percentages: [5, 10, 15], smart_tip_threshold: 5 },
      usd: { fixed_amounts: [100, 200] },
    },
  });
}

async function auditTipping(id) {
  const cfg = await stripe.terminal.configurations.retrieve(id);
  const { bgn, eur } = cfg.tipping;
  const summary = {
    euroPresets: eur ? eur.percentages : [],
    levPresets: cfg.tipping.bgn ? cfg.tipping.bgn.percentages : [],
  };
  if (cfg.tipping.bgn) summary.hasLev = true;
  return summary;
}

async function usdFallback(id) {
  const cfg = await stripe.terminal.configurations.retrieve(id);
  // Multi-line destructuring pattern: the line-level rule honestly skips
  // it (no tipping anchor on the entry line), so the AST pass must drop
  // the dead bgn binding while keeping the referenced usd sibling.
  const {
    bgn,
    usd,
  } = cfg.tipping;
  return usd.fixed_amounts.length;
}

module.exports = { createTerminalConfig, auditTipping, usdFallback };
