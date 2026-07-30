// Fixture: bare-identifier alias of a proven plain-local instance (Loop 375).
// `const gateway = sc;` copies the proven client reference — the alias holds
// the same object (value identity). Non-proven sources, rebound aliases,
// prose lookalikes, call-bearing RHS and alias-of-alias all stay silent.
const Stripe = require('stripe');

// wakeRX1 / wakeRX2: plain alias of a proven instance, two consumers.
const sc = new Stripe(process.env.STRIPE_KEY);
const gateway = sc;
async function firstPair() {
  await gateway.radar_alias_rails.wakeRX1('r_1');
  await gateway.issuing_alias_grants.wakeRX2({ limit: 3 });
}

// wakeRX3: `let` alias, declared then consumed, never reassigned.
let backupClient = sc;
async function third() {
  await backupClient.treasury_alias_drafts.wakeRX3('td_1');
}

// dropRX4: alias of a non-proven local — must never mint.
const legacyRig = buildLegacyRig();
const wormRX = legacyRig;
async function fourth() {
  await wormRX.billing_alias_windows.dropRX4('w_1');
}

// dropRX5: alias later rebound to a non-proven value — guard drops it.
let flexRX = sc;
flexRX = buildLegacyRig();
async function fifth() {
  await flexRX.billing_alias_windows.dropRX5('w_2');
}

// dropRX6: prose lookalikes — comment and string must never mint.
// const phantomRX = sc;  (documented pattern, not code)
const noteRX = "const phantomRX = sc; await phantomRX.billing_alias_windows.dropRX6('w_3')";

// dropRX7: call-bearing RHS — wrapped value is not a bare identifier alias.
const shellRX = wrapRig(sc);
async function seventh() {
  await shellRX.billing_alias_windows.dropRX7('w_4');
}

module.exports = { firstPair, third, fourth, fifth, noteRX, seventh };
