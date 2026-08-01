// Data-plane reader: uses the @vercel/edge-config npm package and the
// edge-config.vercel.com connection string. NEITHER is the management API —
// the v1.28.14 rename does not touch the data plane, so this file must
// survive the fix byte-identical (negative control for the pack's anchored
// path shapes).
const { createClient } = require('@vercel/edge-config');

const client = createClient(
  'https://edge-config.vercel.com/ecfg_demo_store?token=demo',
);

async function readFlag(key) {
  return client.get(key);
}

module.exports = { readFlag };
