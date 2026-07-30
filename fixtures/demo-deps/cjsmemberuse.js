// CJS pure-member named-slot consumer: no provider require of its own —
// chains resolve only through the pure-member slot handshake against
// lib/cjsmember.js. Positives: destructure of member-published slots with
// prefix accumulation. Negatives: slots created from a call-bearing RHS, an
// expression tail, or an unproven root must never root a chain.
const { chargesApi, readersApi: rd } = require('./lib/cjsmember');

async function captureCharge(id) {
  return chargesApi.captureM(id);
}

async function cancelReader(id) {
  return rd.cancelActionM(id);
}

// Negatives: none of these may ever surface.
const { oneCharge, maybeTerm, fake } = require('./lib/cjsmember');
function pokeNegatives() {
  oneCharge.refreshM();
  maybeTerm.readers.createM({});
  fake.createM({});
}

// String lookalike must never be parsed as a member-slot export:
const doc = "exports.chargesApi = stripeM.charges;";

module.exports = { captureCharge, cancelReader, pokeNegatives, doc };
