// Gold fixture — Loop 373: plain-local instance rebinding guard.
// A plain local (`let sc = new Stripe(k)`) reassigned to a non-proven value
// no longer holds the proven client; its chains must go silent (the pg
// candidate from Loop 371, probe-verified false positive). Proven
// reassignments (same-module re-construction, fallback `?? new`, bare
// null/undefined placeholder) keep the binding, and comment lookalikes are
// rejected structurally by the statement-start anchor.
const Stripe = require('stripe');

// wakeQO1: never rebound — baseline keeps emitting.
const clientQO1 = new Stripe(process.env.STRIPE_KEY);
async function runQO1() {
  return clientQO1.radar_flow_lists.wakeQO1();
}

// wakeQO2: rebound to another construction from the SAME proven binding —
// still the proven client, keeps emitting.
let clientQO2 = new Stripe(process.env.STRIPE_KEY);
clientQO2 = new Stripe(process.env.STRIPE_ALT_KEY);
async function runQO2() {
  return clientQO2.tax_calc_runs.wakeQO2();
}

// wakeQO3: bare null placeholder reset (teardown idiom, Loop 325 whitelist)
// does not drop the binding.
let clientQO3 = new Stripe(process.env.STRIPE_KEY);
async function runQO3() {
  const out = await clientQO3.portal_configs.wakeQO3();
  clientQO3 = null;
  return out;
}

// wakeQO4: fallback-memo reassignment — RHS contains a proven same-module
// construction, keeps the binding.
let clientQO4 = new Stripe(process.env.STRIPE_KEY);
clientQO4 = globalThis.memoQO4 ?? new Stripe(process.env.STRIPE_KEY);
async function runQO4() {
  return clientQO4.meter_event_streams.wakeQO4();
}

// wakeQO5: comment lookalike reassignment is rejected structurally by the
// statement-start anchor — binding survives.
const clientQO5 = new Stripe(process.env.STRIPE_KEY);
// clientQO5 = makeWraithGateway();
async function runQO5() {
  return clientQO5.treasury_recv_credits.wakeQO5();
}

// dropQO6: rebound to a non-proven call — the local no longer holds the
// proven client; every chain goes silent.
let clientQO6 = new Stripe(process.env.STRIPE_KEY);
clientQO6 = makeWraithGateway();
async function runQO6() {
  return clientQO6.issuing_personal_docs.dropQO6();
}

// dropQO7: rebound to a DIFFERENT module's construction — ambiguous holder,
// drops.
const OtherSdk = require('other-sdk');
let clientQO7 = new Stripe(process.env.STRIPE_KEY);
clientQO7 = new OtherSdk(process.env.OTHER_KEY);
async function runQO7() {
  return clientQO7.terminal_readers_x.dropQO7();
}

module.exports = { runQO1, runQO2, runQO3, runQO4, runQO5, runQO6, runQO7 };
