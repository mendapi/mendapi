// Loop 372 fixture — plain member alias off a proven container field.
// Positive cases mint via `const local = container.field;` (the statement
// ends right after the field); negatives (non-proven field, rebinding,
// prose, deep trailing chain, call-bearing RHS) all stay silent.
const Stripe = require('stripe');

// wakeQI1/QI2: plain alias of a proven literal-initializer field, two
// consumers on the local.
const servicesQI = { sc: new Stripe(process.env.STRIPE_KEY) };
const sc = servicesQI.sc;
async function wakeQI1() {
  return sc.radar_readings.list({});
}
async function wakeQI2() {
  return sc.issuing_tokens.create({});
}

// wakeQI3: renamed alias off an assignment-minted container field.
const depotQI = {};
depotQI.core = new Stripe(process.env.STRIPE_KEY);
const payQI = depotQI.core;
async function wakeQI3() {
  return payQI.treasury_outbound.retrieve('x');
}

// dropQI4: aliasing a NON-proven field never mints.
const mixbagQI = { sc: new Stripe(process.env.STRIPE_KEY), voidrail: buildLegacyBagQI() };
const voidrail = mixbagQI.voidrail;
async function dropQI4() {
  return voidrail.dropQI4.create({});
}

// dropQI5: aliased local REBOUND later never mints (one-hop strict guard).
const crateQI = { sc: new Stripe(process.env.STRIPE_KEY) };
let mistrailQI = crateQI.sc;
mistrailQI = buildLegacyBagQI();
async function dropQI5() {
  return mistrailQI.dropQI5.create({});
}

// dropQI6: prose lookalikes (comment + string) never mint.
// const wraithrailQI = servicesQI.sc;
const noteQI = "const wraithrailQI = servicesQI.sc; wraithrailQI.dropQI6.list()";
async function dropQI6() {
  return noteQI.length;
}

// dropQI7: deep trailing chain is NOT a plain field alias — stays on the
// sub-client / AST track (never guess a derived sub-object).
const shelfbinQI = servicesQI.sc.dropQI7chain;
async function dropQI7() {
  return shelfbinQI.dropQI7.list({});
}

module.exports = { wakeQI1, wakeQI2, wakeQI3, dropQI4, dropQI5, dropQI6, dropQI7 };
