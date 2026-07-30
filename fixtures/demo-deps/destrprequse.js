// Consumer-side destructure of a property-selected require:
//   const { terminal: term } = require('./lib/cjsclient').stripeCjs;
// Head dispatch against the target's proven export table, then each
// destructured key appends one pure member segment onto the prefix.
// Negatives: expression tail, missing head member, default-value picks,
// rest picks, redeclared locals and string lookalikes must never bind.
const { terminal: term, mandates } = require('./lib/cjsclient').stripeCjs;

async function readerS() {
  return term.readers.processS('tr_2');
}

async function mandateS() {
  return mandates.retrieveS('mnd_1');
}

// Negative: expression tail — not a pure member selection.
const { radar } = require('./lib/cjsclient').stripeCjs || {};
// Negative: head member absent from the proven table.
const { disputes } = require('./lib/cjsclient').missingHeadZZ;
// Negative: default-value pick is not a pure member pick.
const { topups: tps = {} } = require('./lib/cjsclient').stripeCjs;
// Negative: another line-anchored declaration of the same name (shadow).
const { invoices } = require('./lib/cjsclient').stripeCjs;
function invSetup() {
  const invoices = { finalizeS() {} };
  return invoices;
}
function pokeNegativesS() {
  radar.listS({});
  disputes.closeS('dp_2');
  tps.createS({});
  invoices.finalizeS('in_2');
}

// String lookalike must never be parsed as a binding:
const docS = "const { payouts } = require('./lib/cjsclient').stripeCjs;";

module.exports = { readerS, mandateS, pokeNegativesS, docS };
