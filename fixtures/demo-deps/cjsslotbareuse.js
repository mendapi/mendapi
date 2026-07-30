// CJS bare named-slot barrel consumer: no provider require of its own —
// chains resolve only through lib/cjsslotbare.js slots. Positive: the slot
// forwarding a target's '@default' roots a chain. Negatives: slots created
// from a named-only target, an expression tail, or a bare package require
// must never root a chain.
const { core } = require('./lib/cjsslotbare');

async function fetchMandate() {
  return core.mandates.retrieveG('mandate_1');
}

// Negatives: none of these may ever surface.
const { namedOnly } = require('./lib/cjsslotbare');
const { risky } = require('./lib/cjsslotbare');
const { vendor } = require('./lib/cjsslotbare');
function pokeNegatives() {
  namedOnly.disputes.closeG('dp_1');
  risky.radar.listG({});
  vendor.topups.createG({});
}

// String lookalike must never be parsed as a forwarding statement:
const doc = "exports.core = require('./clientmod.mjs');";

module.exports = { fetchMandate, pokeNegatives, doc };
