// Loop 371 fixture — destructured pull of proven container fields.
// Positive cases mint via `const { field } = container` / renamed
// `{ field: local }`; negatives (non-proven field, rebinding, prose,
// default/rest patterns) all stay silent.
const Stripe = require('stripe');

// wakeQE1/QE2: plain destructure of a proven literal-initializer field,
// two consumers on the local.
const services = { sc: new Stripe(process.env.STRIPE_KEY) };
const { sc } = services;
async function wakeQE1() {
  return sc.terminal_fleets.list({});
}
async function wakeQE2() {
  return sc.billing_meter_summaries.create({});
}

// wakeQE3: renamed destructure ({ field: local }) off an assignment-minted
// container field.
const depotQE = {};
depotQE.core = new Stripe(process.env.STRIPE_KEY);
const { core: payQE } = depotQE;
async function wakeQE3() {
  return payQE.payout_reversals.retrieve('x');
}

// dropQE4: destructuring a NON-proven field never mints.
const mixbagQE = { sc: new Stripe(process.env.STRIPE_KEY), voidlane: buildLegacyBagQE() };
const { voidlane } = mixbagQE;
async function dropQE4() {
  return voidlane.dropQE4.create({});
}

// dropQE5: destructured local REBOUND later never mints (one-hop strict guard).
const crateQE = { sc: new Stripe(process.env.STRIPE_KEY) };
let { sc: mistlane } = crateQE;
mistlane = buildLegacyBagQE();
async function dropQE5() {
  return mistlane.dropQE5.create({});
}

// dropQE6: prose lookalikes (comment + string) never mint.
// const { sc: mistrail } = services;
const noteQE = "const { sc: mistrail } = services; mistrail.dropQE6.list()";
async function dropQE6() {
  return noteQE.length;
}

// dropQE7: default value in the pattern is structurally rejected (never guess).
const { sc: trailbagQE = fallbackQE() } = services;
async function dropQE7() {
  return trailbagQE.dropQE7.list({});
}

module.exports = { wakeQE1, wakeQE2, wakeQE3, dropQE4, dropQE5, dropQE6, dropQE7 };
