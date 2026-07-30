// CJS named-slot BARE forwarding barrel: `exports.<slot> = require('./rel')`
// with no member selection. The slot's value is the target module's whole
// export value, so only a target with a proven '@default' entry (a bare
// `export default client` / `module.exports = client` module) forwards — it
// is re-published under the named slot. Consumers: see ../cjsslotbareuse.js.

// Positive: clientmod.mjs has a proven '@default' (export default stripeClient).
exports.core = require('./clientmod.mjs');

// Negative-turned-namespace: cjsclient.js exposes named exports only (object
// literal) — no single provable export value, so nothing forwards as a plain
// entry. Since Loop 186 the slot IS published as a NAMESPACE slot instead:
// consumers dispatch chains against the target's proven table (see
// ../cjsnsslotuse.js). Members absent from that table still never bind.
exports.namedOnly = require('./cjsclient');

// Negative: expression tail — never a pure bare forwarding statement.
exports.risky = require('./clientmod.mjs') || {};

// Negative: bare package require never joins the module graph.
exports.vendor = require('stripe');
