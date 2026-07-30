// Fixture: namespace-object property constructor bindings (Loop 368).
// A plain named container object holding a proven-ctor client:
//   ledger.sc = new Stripe(key);  ...  ledger.sc.<chain>(...)
// Wake cases QK1-QK4; drop cases QK5-QK8.
const Stripe = require('stripe');

// wakeQK1/QK2: statement-start mint + two consumer chains.
const ledger = {};
ledger.sc = new Stripe(process.env.STRIPE_KEY);
async function pushLedger() {
  const a = await ledger.sc.tax_settings.wakeQK1({ amount: 5 });
  const b = await ledger.sc.entitlements_features.wakeQK2({ limit: 3 });
  return [a, b];
}

// wakeQK3: lazy-init ??= spelling on a container property.
const vaultbox = {};
vaultbox.api ??= new Stripe(process.env.STRIPE_KEY);
async function pullVault() {
  return await vaultbox.api.forwarding_requests_v2.wakeQK3('fr_1');
}

// wakeQK4: inline (`;`-position) mint — second statement on one line,
// plus a null placeholder reset that the Loop 325 whitelist must accept.
const depot = {}; depot.core = new Stripe(process.env.STRIPE_KEY);
function resetDepotLater() { depot.core = null; }
async function drainDepot() {
  return await depot.core.climate_products_v2.wakeQK4({});
}

// dropQK5: ambiguity — same root.field also assigned from a non-proven RHS.
const hublet = {};
hublet.sc = new Stripe(process.env.STRIPE_KEY);
hublet.sc = makeLegacyGateway();
async function spinHublet() {
  return await hublet.sc.radar_value_lists.dropQK5({});
}

// dropQK6: root rebinding — the container itself is replaced after mint.
let crate = {};
crate.sc = new Stripe(process.env.STRIPE_KEY);
crate = buildDifferentCrate();
async function tipCrate() {
  return await crate.sc.sigma_scheduled_queries.dropQK6({});
}

// dropQK7: prose lookalikes — comment and string must never mint.
// prosebox.sc = new Stripe(key); prosebox.sc.issuing_personalization.dropQK7()
const proseNote = "prosebox.sc = new Stripe(key); prosebox.sc.issuing_personalization.dropQK7()";

// dropQK8: derived-object trailer — not the client itself (Loop 338).
const trail = {};
trail.sub = new Stripe(process.env.STRIPE_KEY).billing_portal_configs;
async function walkTrail() {
  return await trail.sub.sessions_v3.dropQK8({});
}

module.exports = { pushLedger, pullVault, drainDepot, spinHublet, tipCrate, proseNote, walkTrail };
