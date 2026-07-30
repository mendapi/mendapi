// CJS barrel fixture: `module.exports = require('./rel')` re-points this
// module's entire exports object at ../lib/cjsclient.js's proven table.
// Unlike ESM `export *`, this forwards the whole export value — named
// entries AND the default sentinel. Consumers: see ../cjsbarreluse.js.
module.exports = require('./cjsclient');
