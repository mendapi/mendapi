// CJS named-slot barrel consumer: no provider require of its own — chains
// resolve only through lib/cjsslotbarrel.js named slots. Positives: destructure
// (plain and aliased) of forwarded slots. Negatives: slots created from an
// expression tail, a missing member, or a bare package require must never
// root a chain.
const { pay } = require('./lib/cjsslotbarrel');
const { term: t } = require('./lib/cjsslotbarrel');

async function listClimate() {
  return pay.climate.listQ({});
}

async function makeReader() {
  return t.readers.createQ({});
}

// Negatives: none of these may ever surface.
const { risky } = require('./lib/cjsslotbarrel');
const { ghost } = require('./lib/cjsslotbarrel');
const { vendor } = require('./lib/cjsslotbarrel');
function pokeNegatives() {
  risky.radar.listW({});
  ghost.disputes.closeW('dp_1');
  vendor.createW({});
}

// String lookalike must never be parsed as a forwarding statement:
const doc = "exports.pay = require('./cjsclient').stripeCjs;";

module.exports = { listClimate, makeReader, pokeNegatives, doc };
