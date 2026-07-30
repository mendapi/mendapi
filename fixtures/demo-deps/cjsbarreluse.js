// CJS barrel consumer: no provider require of its own — chains resolve only
// through lib/cjsbarrel.js, which re-points its whole module.exports at
// lib/cjsclient.js. Positive: named + renamed entries forwarded through the
// CJS bare re-assignment. Negatives: unproven exports and lookalike lines
// must never root a chain.
const { stripeCjs, payoutsApi: pb } = require('./lib/cjsbarrel');

async function listDisputes() {
  return stripeCjs.disputes.listAll({ limit: 2 });
}

// Alias prefix must survive the barrel hop: surfaces as client.payouts.reverseX.
async function reversePayout(id) {
  return pb.reverseX(id);
}

// Negative: unproven export stays unproven through the barrel.
const { notaclient } = require('./lib/cjsbarrel');
function pokeB() {
  return notaclient.refresh();
}

// Negative: a string mentioning the forwarding statement is not a barrel.
const doc = "module.exports = require('./lib/cjsclient')";
function docLen() {
  return doc.length;
}

module.exports = { listDisputes, reversePayout, pokeB, docLen };
