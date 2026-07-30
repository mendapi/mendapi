// Loop 310: JS ternary-spelled fallback construction — the pre-ES2020
// verbose spelling of the memoized-singleton idiom
// (`const s = cached ? cached : new Stripe(k)` === `cached || new Stripe(k)`).
// Binds only when the condition operand and the consequent are the SAME
// simple dotted identifier chain; anything else stays AST track.
const Stripe = require('stripe');

// TF1: same-operand ternary fallback — binds; the chain below must be
// inventoried.
const fallTF = global._stripeTF ? global._stripeTF : new Stripe(process.env.STRIPE_KEY);
const outTF = fallTF.payouts.flipTF1({ amount: 7 });

// TF2: DIFFERENT consequent — the truthy arm is arbitrary, must NOT bind;
// the chain stays silent (AST track), never a phantom.
const mixTF = global._flagTF ? global._otherTF : new Stripe(process.env.STRIPE_KEY);
function runTF2(mixTF2) {
  return mixTF.plans.holdTF2({ id: 'p' });
}

// TF3: call-expression operand — a call is not guaranteed idempotent, must
// NOT bind (honest skip); the chain stays silent.
const callTF = getCachedTF() ? getCachedTF() : new Stripe(process.env.STRIPE_KEY);
function getCachedTF() { return null; }
function runTF3() {
  return callTF.refunds.markTF3({ id: 'r' });
}

// TF4: ternary fallback line quoted inside a multi-line template body —
// phantom instance must not mint; the parameter `tfq` below must stay silent.
const fallDoc = `Legacy bootstrap:
const tfq = cached ? cached : new Stripe(k);
delete after migrating to ??`;
function shipTF(tfq) {
  return tfq.disputes.bumpTF4({ id: 'd' });
}

module.exports = { fallTF, outTF, runTF2, runTF3, fallDoc, shipTF };
