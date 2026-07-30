// NOT a Stripe file: the pack's provider guard must leave it untouched even
// though it reads an .iin member (an unrelated internal shape).
const registry = require('./registry');

function issuerLookup(record) {
  return registry.find(record.card.iin) || null;
}

module.exports = { issuerLookup };
