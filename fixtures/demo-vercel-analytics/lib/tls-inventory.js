// TLS handshake inventory for the ops runbook. This module never touches
// the analytics query surface, so the mend must leave it alone even
// though it reuses the same key name for its own records.
const INVENTORY = [
  { host: 'edge-1.internal', dheCipherSuite: 'DHE-RSA-AES256-GCM-SHA384' },
  { host: 'edge-2.internal', dheCipherSuite: 'DHE-RSA-AES128-GCM-SHA256' },
];

function suitesInUse() {
  const seen = new Set();
  for (const record of INVENTORY) seen.add(record.dheCipherSuite);
  return [...seen];
}

module.exports = { INVENTORY, suitesInUse };
