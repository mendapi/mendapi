// Two-hop bare-identifier aliases of a proven plain-local instance (Loop 376).
const Stripe = require('stripe');
const sc = new Stripe(process.env.STRIPE_KEY);

// Positive: hop 1 then hop 2 — both consumer chains must emit.
const gatewayRW = sc;
const backupRW = gatewayRW;

// Positive: three-hop chain, still within the fixpoint bound.
const midRW = backupRW;

async function wake() {
  await backupRW.radar_hop_rails.wakeRW1({ limit: 1 });
  await backupRW.issuing_hop_grants.wakeRW2({ amount: 5 });
  await midRW.treasury_hop_drafts.wakeRW3();
}

// Negative: alias of an unproven local — never mints.
const legacyRW = makeLegacyGatewayRW();
const shadowRW = legacyRW;
async function dropA() {
  await shadowRW.payout_hop_ledgers.dropRW4();
}

// Negative: middle hop rebound after aliasing — downstream hop never mints.
let flakyRW = sc;
const tailRW = flakyRW;
flakyRW = makeLegacyGatewayRW();
async function dropB() {
  await tailRW.payout_hop_ledgers.dropRW5();
}

// Negative: prose lookalikes of a second hop.
// const proseRW = gatewayRW;
const noteRW = 'const proseRW2 = gatewayRW;';
async function dropC() {
  await proseRW.payout_hop_ledgers.dropRW6();
}

module.exports = { wake, dropA, dropB, dropC, noteRW };
