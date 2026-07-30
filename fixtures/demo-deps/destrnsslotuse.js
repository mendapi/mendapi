// Destructure of a property-selected require where the selected head is a
// NAMESPACE slot (Loop 190): the facade publishes
// `exports.namedOnly = require('./cjsclient')` (target has ONLY named
// exports), so `require('./lib/cjsslotbare').namedOnly` is the target's
// module namespace — each destructured key is a lookup in that target's
// line-proven export table (same dispatch as `import * as`). With a second
// segment (`.namedOnly.entry`) the entry is selected first and keys append
// as pure member segments onto its prefix.

// Positive: per-key table dispatch on the slot namespace (plain + alias key).
const { stripeCjs: dsClient, payoutsApi: dsPo } = require('./lib/cjsslotbare').namedOnly;
async function dsCap() {
  return dsClient.charges.captureDS1('ch_1');
}
async function dsPoCancel() {
  return dsPo.cancelDS2('po_1');
}

// Positive: sub-selection — entry picked by the second segment, key appends
// onto its prefix, chain call on the binding.
const { charges: dsChg } = require('./lib/cjsslotbare').namedOnly.stripeCjs;
async function dsSub() {
  return dsChg.captureDS3('ch_2');
}

// Negative: ghost key absent from the slot target's table — never binds.
const { ghostKey: dsGhost } = require('./lib/cjsslotbare').namedOnly;
function dsPokeGhost() {
  dsGhost.refunds.createDS4({});
}

// Negative: ghost second segment — never binds.
const { alpha: dsAlpha } = require('./lib/cjsslotbare').namedOnly.ghostEntry;
function dsPokeAlpha() {
  dsAlpha.betaDS5({});
}

// Negative: default-value key is not a pure member pick — skipped.
const { stripeCjs: dsDef = {} } = require('./lib/cjsslotbare').namedOnly;
function dsPokeDef() {
  dsDef.charges.createDS6({});
}

// Negative: expression-tail slot is never a namespace slot.
const { stripeCjs: dsRisky } = require('./lib/cjsslotbare').risky;
function dsPokeRisky() {
  dsRisky.charges.createDS7({});
}

// Negative: string lookalike never parses.
const dsNote = "const { stripeCjs } = require('./lib/cjsslotbare').namedOnly;";
