// Deferred-assignment constructor binding fixture (Loop 197): the lazy-init
// singleton idiom — declare first, construct later inside an init function.
const Stripe = require('stripe');

let client;
function init(key) {
  client = new Stripe(key);
}

// Positive: the deferred assignment above proves the instance; the chain
// below must surface as stripe client.disputes.retrieveLA1.
async function lookup(id) {
  return client.disputes.retrieveLA1(id);
}

// Positive: await + new on a deferred assignment.
let lateClient;
async function boot(key) {
  lateClient = await new Stripe(key);
}
async function stop(id) {
  return lateClient.topups.cancelLA2(id);
}

// Negative: field targets never bind — obj.fieldClient chains stay silent.
const holder = {};
holder.fieldClient = new Stripe('k');
function ghostField() {
  return maybeRef.charges.badLA3({});
}
let maybeRef;

// Negative: assignment without `new` from a non-proven callee never binds.
let other;
function setup() {
  other = makeThing('x');
}
function ghostOther() {
  return other.charges.badLA4({});
}

// Negative: string / comment lookalikes never bind.
// ghost = new Stripe(key) in a comment
const note = 'ghost2 = new Stripe(key) in a string';
function ghostString() {
  return ghost2.charges.badLA5({});
}

// Positive (Loop 198): logical-assignment lazy init — the canonical one-line
// serverless form. Both nullish and or-assign spellings bind.
let nc;
function ensureNc(key) {
  nc ??= new Stripe(key);
}
async function fetchNc(id) {
  return nc.invoices.retrieveLA6(id);
}
let oc;
function ensureOc(key) {
  oc ||= new Stripe(key);
}
async function fetchOc(id) {
  return oc.plans.listLA7(id);
}

// Negative (Loop 198): `&&=` only assigns when already truthy — never a
// lazy-init construction, honestly excluded.
let andTarget;
function ghostAnd(key) {
  andTarget &&= new Stripe(key);
}
function ghostAndChain(id) {
  return andTarget.charges.badLA8(id);
}

// Positive (Loop 234): the SAME deferred-assignment proof at inline positions
// — single-line function body and second-statement-on-a-line.
let ic;
function ensureIc(key) { ic = new Stripe(key); }
async function fetchIc(id) {
  return ic.disputes.retrieveLB1(id);
}
let sc2;
function bootPair(key) { let n = 0; sc2 = new Stripe(key); }
async function fetchSc2(id) {
  return sc2.topups.cancelLB2(id);
}

// Negative (Loop 234): destructuring default — the target may take the
// source object's own value (unproven), structurally rejected by the
// `;`-terminator gate (pattern elements end with `,`/`}`).
let dd;
const ddCfg = {};
({ dd = new Stripe('k') } = ddCfg);
function ghostDd(id) {
  return dd.invoices.badLB3(id);
}

// Negative (Loop 234): commented / in-string inline lookalikes never bind.
function ghostIcSetup(key) { /* gc = new Stripe(key); */ }
const lbNote = '{ gs = new Stripe(key); }';
let gc;
let gs;
function ghostLb(id) {
  return gc.plans.badLB4(id) && gs.payouts.badLB5(id);
}

// Positive (Loop 239): fallback-default construction on the declaration line
// — the memoized-singleton idiom (Prisma-recipe style, common for clients).
const mzc = globalThis._stripeLC ?? new Stripe('k');
async function fetchMzc(id) {
  return mzc.quotes.cancelLC1(id);
}
let orc = cachedStripeLC || new Stripe('k');
async function fetchOrc(id) {
  return orc.mandates.retrieveLC2(id);
}

// Negative (Loop 239): ternary / && / call-expression fallback never bind.
const tc1 = flagLC ? new Stripe('k') : null;
function ghostTc1(id) {
  return tc1.charges.badLC3(id);
}
const tc2 = maybeLC && new Stripe('k');
function ghostTc2(id) {
  return tc2.charges.badLC4(id);
}
const tc3 = getCachedLC() ?? new Stripe('k');
function ghostTc3(id) {
  return tc3.charges.badLC5(id);
}
// Negative (Loop 239): commented / in-string fallback lookalikes never bind.
// const tc4 = cachedLC ?? new Stripe('k');
const lcNote = "const tc5 = cachedLC || new Stripe('k');";
let tc4;
let tc5;
function ghostTc45(id) {
  return tc4.charges.badLC6(id) && tc5.charges.badLC7(id);
}

// Positive (Loop 240): fallback-default construction in the DEFERRED position
// — the memoized idiom without a declaration keyword.
let dfc;
function ensureDfc(key) {
  dfc = globalThis._stripeLD ?? new Stripe(key);
}
async function fetchDfc(id) {
  return dfc.subscriptionItems.createLD1(id);
}
let dfo;
function ensureDfo(key) {
  dfo = cachedStripeLD || new Stripe(key);
}
async function fetchDfo(id) {
  return dfo.setupIntents.cancelLD2(id);
}

// Negative (Loop 240): ternary / && / call-expression fallback in the
// deferred position never bind.
let dt1;
function ghostDt1(key) {
  dt1 = flagLD ? new Stripe(key) : null;
}
function ghostDt1Use(id) {
  return dt1.charges.badLD3(id);
}
let dt2;
function ghostDt2(key) {
  dt2 = maybeLD && new Stripe(key);
}
function ghostDt2Use(id) {
  return dt2.charges.badLD4(id);
}
let dt3;
function ghostDt3(key) {
  dt3 = getCachedLD() ?? new Stripe(key);
}
function ghostDt3Use(id) {
  return dt3.charges.badLD5(id);
}
// Negative (Loop 240): commented deferred fallback lookalike never binds.
// dt4 = cachedLD ?? new Stripe(key);
let dt4;
function ghostDt4Use(id) {
  return dt4.charges.badLD6(id);
}

// Positive (Loop 241): fallback-default construction in the INLINE positions
// — single-line body and second-statement-on-a-line forms of the memoized
// idiom.
let ifc;
function ensureIfc(key) { ifc = globalThis._stripeLE ?? new Stripe(key); }
async function fetchIfc(id) {
  return ifc.taxRates.createLE1(id);
}
let ifo;
const seedLE = 1; ifo = cachedStripeLE || new Stripe(seedLE);
async function fetchIfo(id) {
  return ifo.payouts.cancelLE2(id);
}

// Negative (Loop 241): call-expression fallback, destructuring default, and
// in-string lookalikes in the inline position never bind.
let ie1;
function ghostIe1(key) { ie1 = getCachedLE() ?? new Stripe(key); }
function ghostIe1Use(id) {
  return ie1.charges.badLE3(id);
}
let ie2;
function ghostIe2(cfg, key) { ({ ie2 = cachedLE ?? new Stripe(key) } = cfg); }
function ghostIe2Use(id) {
  return ie2.charges.badLE4(id);
}
let ie3;
const leNote = "x; ie3 = cachedLE ?? new Stripe(k);";
function ghostIe3Use(id) {
  return ie3.charges.badLE5(id);
}

module.exports = { init, lookup, boot, stop, setup, ghostField, ghostOther, ghostString, note, ensureNc, fetchNc, ensureOc, fetchOc, ghostAnd, ghostAndChain };
