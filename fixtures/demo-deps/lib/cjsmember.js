// CJS named-slot pure-member re-export fixture (exporting side): the client
// is proven here via require + constructor, then SUB-CLIENTS are published
// under named slots with a pure-member RHS — the CJS twin of
// `export const charges = stripe.charges`. Consumers: see ../cjsmemberuse.js.
const Stripe = require('stripe');
const stripeM = new Stripe(process.env.STRIPE_KEY);

// Positive: exports.<slot> = <proven root>.<member>
exports.chargesApi = stripeM.charges;

// Positive: module.exports.<slot> spelling with a multi-segment member chain
// (prefix accumulation).
module.exports.readersApi = stripeM.terminal.readers;

// Negative: call-bearing RHS is API data, never a client — must not collect.
exports.oneCharge = stripeM.charges.create({ amount: 1 });

// Negative: expression tail breaks the pure-member line anchor.
exports.maybeTerm = stripeM.terminal || {};

// Negative: unproven local root never collects.
const somethingLocal = { charges: { createZ: () => {} } };
exports.fake = somethingLocal.charges;
