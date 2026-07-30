// CommonJS re-export fixture (exporting side): the client is proven here via
// require + constructor, then re-exported under CJS named-export forms. The
// exported-name handshake is identical to ESM `export { ... }` — only the
// spelling differs. Consumers: see ../cjsuse.js.
const Stripe = require('stripe');
const stripeCjs = new Stripe(process.env.STRIPE_KEY);

// Form 1: exports.<name> = <proven root>
exports.stripeCjs = stripeCjs;

// Form 2: single-line module.exports object literal, including `pub: local`
// renames. `notaclient` is an unproven local — must never be collected.
const payouts = stripeCjs.payouts;
const notaclient = { refresh: () => {} };
module.exports = { stripeCjs, payoutsApi: payouts, notaclient };
