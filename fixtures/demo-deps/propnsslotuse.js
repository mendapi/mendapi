// Consumer-side inline property selection where the selected head is a
// NAMESPACE slot (Loop 189): the facade publishes
// `exports.namedOnly = require('./cjsclient')` (target has ONLY named
// exports), so `require('./lib/cjsslotbare').namedOnly` binds the target's
// module namespace — chains dispatch against its line-proven export table,
// exactly like `import * as`. A second inline segment selects an entry of
// that table directly, with any remaining segments joining its prefix.

// Positive: namespace binding via slot selection; chain dispatches the table.
const nsPick = require('./lib/cjsslotbare').namedOnly;
async function capViaPick() {
  return nsPick.stripeCjs.charges.capturePS1('ch_1');
}

// Positive: sub-selection — second segment hits `payoutsApi` (prefix
// ['payouts']); the call is a direct member of the selected entry.
const poPick = require('./lib/cjsslotbare').namedOnly.payoutsApi;
async function poViaPick() {
  return poPick.cancelPS2('po_1');
}

// Negative: second segment absent from the slot target's table — never binds.
const ghostPick = require('./lib/cjsslotbare').namedOnly.ghostEntry;
function pokeGhost() {
  ghostPick.refunds.createPS3({});
}

// Negative: expression-tail slot is never a namespace slot.
const riskyPick = require('./lib/cjsslotbare').risky;
function pokeRisky() {
  riskyPick.stripeCjs.disputes.closePS4('d');
}

// Negative: single-segment call on the namespace binding — no chain.
function pokePing() {
  nsPick.pingPS5();
}

// Negative: shadowed local — another declaration of the same name exists
// (the guard is line-anchored across the file, scope-agnostic on purpose).
const shadPick = require('./lib/cjsslotbare').namedOnly;
function pokeShadow() {
  function shadPick() {}
  return shadPick;
}
function pokeShadow2() {
  shadPick.stripeCjs.topups.createPS6({});
}

// Negative: string lookalike never resolves.
const docPick = "const z = require('./lib/cjsslotbare').namedOnly;";

module.exports = { capViaPick, poViaPick, pokeGhost, pokeRisky, pokePing, pokeShadow, docPick };
