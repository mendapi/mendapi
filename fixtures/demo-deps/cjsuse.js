// CommonJS re-export fixture (consuming side): no provider require of its
// own — chains below resolve only through the require-destructure handshake
// against lib/cjsclient.js (relative specifier, extensionless).
const { stripeCjs, payoutsApi: po } = require('./lib/cjsclient');

async function listBalanceTx() {
  return stripeCjs.balanceTransactions.list({ limit: 3 });
}

// Alias prefix must accumulate across files: surfaces as client.payouts.cancel.
async function cancelPayout(id) {
  return po.cancel(id);
}

// Negative: unproven export never roots a chain (notaclient.refresh silent).
const { notaclient } = require('./lib/cjsclient');
function poke() {
  return notaclient.refresh();
}

module.exports = { listBalanceTx, cancelPayout, poke };
