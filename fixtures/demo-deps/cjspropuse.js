// CJS property-selection barrel consumer: no provider require of its own —
// chains resolve only through lib/cjspropbarrel.js, whose module.exports IS
// the selected proven member of lib/cjsclient.js. Positive: bare require of
// the prop barrel joins via the forwarded '@default'. Negatives: an
// expression re-assignment barrel never forwards; a missing member never
// forwards.
const pay = require('./lib/cjspropbarrel');

async function listMandates() {
  return pay.mandates.retrieveK('mandate_1');
}

// Negative: expression barrel (`... || {}`) must never root a chain.
const exprPick = require('./lib/cjspropexpr');
function pokeExpr() {
  return exprPick.radar.listV({});
}

module.exports = { listMandates, pokeExpr };
