// CJS property-selection barrel fixture: `module.exports = require('./rel').name`
// re-points this module's export value at ONE proven member of the target's
// table — published as this module's '@default'. The trailing member chain is
// pure prefix (line ends after the chain, so no call can hide in the RHS).
// Consumers: see ../cjspropuse.js.
module.exports = require('./cjsclient').stripeCjs;
