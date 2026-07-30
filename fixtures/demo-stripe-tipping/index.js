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

module.exports = { createTerminalConfig, auditTipping };
