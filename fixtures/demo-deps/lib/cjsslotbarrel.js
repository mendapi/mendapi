// CJS named-slot property-selection barrel fixture:
// `exports.<slot> = require('./rel').<member>` publishes ONE selected proven
// member of the target's table under a NAMED export slot (Loop 178 forwarded
// the whole-module form as '@default'; this is the named-slot sibling).
// Consumers: see ../cjsslotuse.js.

// Positive: named slot selection of a proven client.
exports.pay = require('./cjsclient').stripeCjs;

// Positive: module.exports.<slot> spelling with a trailing member chain —
// pure prefix accumulation (line ends after the chain).
module.exports.term = require('./cjsclient').stripeCjs.terminal;

// Negative: expression tail — the export value is no longer a pure member
// selection, so nothing may forward.
exports.risky = require('./cjsclient').stripeCjs || {};

// Negative: member absent from the proven table never forwards.
exports.ghost = require('./cjsclient').missingZZ;

// Negative: bare package require never joins the module graph.
exports.vendor = require('stripe').charges;
