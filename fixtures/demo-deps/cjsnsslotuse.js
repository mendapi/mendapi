// CJS namespace-object-under-slot consumer (Loop 186): the facade publishes
// `exports.namedOnly = require('./cjsclient')` where the target has ONLY
// named exports — no single provable export value, so the slot is a
// NAMESPACE binding: chains dispatch their first segment against the
// target's line-proven export table (same insight as `import * as`).
const { namedOnly } = require('./lib/cjsslotbare');

async function captureViaNs() {
  // Positive: `stripeCjs` is a proven entry of cjsclient's table.
  return namedOnly.stripeCjs.charges.captureN('ch_1');
}

async function payoutViaNs() {
  // Positive: `payoutsApi` carries prefix ['payouts'] in the proven table.
  return namedOnly.payoutsApi.cancelN('po_1');
}

function pokeNegatives() {
  // Negative: `notaclient` is an unproven local in the target — never binds.
  namedOnly.notaclient.refreshN();
  // Negative: member absent from the proven table — never binds.
  namedOnly.ghost.refunds.createN({});
  // Negative: single-segment call has no chain to dispatch.
  namedOnly.pingN();
}

// Negative: a forwarding statement inside a string must never create a slot
// (the exporting-side guard, mirrored here for reading clarity).
const doc = "exports.other = require('./cjsclient');";

module.exports = { captureViaNs, payoutViaNs, pokeNegatives, doc };
