// Consumer-side inline property selection (no barrel in between):
//   const pay = require('./lib/cjsclient').stripeCjs;
// The binding is created in THIS consuming file — head dispatch against the
// target's proven export table, trailing segments accumulate as prefix.
// Negatives: expression tail, missing member, redeclared local, and string
// lookalikes must never root a chain.
const pay = require('./lib/cjsclient').stripeCjs;
const rd = require('./lib/cjsclient').stripeCjs.terminal;

async function paySomething() {
  return pay.topups.createR({});
}

async function reader() {
  return rd.readers.cancelR('tr_1');
}

// Negative: expression tail — not a pure member selection.
const risky = require('./lib/cjsclient').stripeCjs || {};
// Negative: member absent from the proven table.
const ghost = require('./lib/cjsclient').missingZZ;
// Negative: another line-anchored declaration of the same name (shadow).
const dup = require('./lib/cjsclient').stripeCjs;
function dupSetup() {
  const dup = { radar: { listR() {} } };
  return dup;
}
function pokeNegatives() {
  risky.radar.listR({});
  ghost.disputes.closeR('dp_1');
  dup.invoices.payR('in_1');
}

// String lookalike must never be parsed as a binding:
const doc = "const pay = require('./lib/cjsclient').stripeCjs;";

module.exports = { paySomething, reader, pokeNegatives, doc };
