// Fixture: object-literal property constructor initializers (Loop 369).
// The container is declared with the client already inside:
//   const satchel = { sc: new Stripe(key) };  ...  satchel.sc.<chain>(...)
// Wake cases QC1-QC3; drop cases QC4-QC7.
const Stripe = require('stripe');

// wakeQC1/QC2: single-property literal + two consumer chains.
const satchel = { sc: new Stripe(process.env.STRIPE_KEY) };
async function openSatchel() {
  const a = await satchel.sc.billing_meters_lit.wakeQC1({ amount: 2 });
  const b = await satchel.sc.tax_forms_lit.wakeQC2({ limit: 9 });
  return [a, b];
}

// wakeQC3: multi-line literal, proven initializer among plain props.
const pouch = {
  label: 'billing',
  api: new Stripe(process.env.STRIPE_KEY),
  retries: 3,
};
async function shakePouch() {
  return await pouch.api.invoice_items_lit.wakeQC3({});
}

// dropQC4: ternary-arm lookalike — `prior :` is a ternary arm, not a key.
const priorGate = null;
const bundlebox = { pick: process.env.MODE ? priorGate : new Stripe(process.env.STRIPE_KEY) };
async function crackBundle() {
  return await bundlebox.pick.payout_lits.dropQC4({});
}

// dropQC5: nested literal — not addressable as `root.field`, never mints.
const duffel = { inner: { sc: new Stripe(process.env.STRIPE_KEY) } };
async function unzipDuffel() {
  return await duffel.inner.sc.financial_connections_lit.dropQC5({});
}

// dropQC6: root rebinding after a literal mint drops all fields.
let caddy = { sc: new Stripe(process.env.STRIPE_KEY) };
caddy = buildDifferentCaddy();
async function rollCaddy() {
  return await caddy.sc.terminal_locations_lit.dropQC6({});
}
function buildDifferentCaddy() { return {}; }

// dropQC7: prose lookalikes — string and comment must never mint.
// const phantombag = { sc: new Stripe(key) }; phantombag.sc.climate_lits.dropQC7()
const proseBag = "const phantombag = { sc: new Stripe(key) }; phantombag.sc.climate_lits.dropQC7()";

module.exports = { openSatchel, shakePouch, crackBundle, unzipDuffel, rollCaddy, proseBag };
