// Negative fixture: expression re-assignments are NOT property-selection
// barrels — a `||` fallback (or any expression tail) means the export value
// is no longer a pure member selection, so nothing may forward. Consumers of
// this file must never root a chain. See ../cjspropuse.js.
module.exports = require('./cjsclient').stripeCjs || {};
