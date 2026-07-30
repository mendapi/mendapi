// Loop 304: JS both-arms ternary constructor binding — the test/live key
// idiom (`const client = isTest ? new Stripe(a) : new Stripe(b)`). Both arms
// constructing from a proven import binding is a construction guarantee, so
// the instance binds; a non-constructing else arm (`: null`) stays AST track,
// and a quoted lookalike in a template body never mints a phantom.
const Stripe = require('stripe')(process.env.STRIPE_KEY);

// JT1: both arms construct — binds; the chain below must be inventoried.
const tornJT = process.env.NODE_ENV === 'test' ? new Stripe(process.env.TEST_KEY) : new Stripe(process.env.LIVE_KEY);
const outJT = tornJT.payouts.flipJT1({ amount: 3 });

// JT2: else arm is not a construction — must NOT bind; the chain stays silent
// (AST track), never a phantom.
const halfJT = process.env.NODE_ENV === 'test' ? new Stripe(process.env.TEST_KEY) : null;
function runJT2(halfJT2) {
  return halfJT.plans.holdJT2({ id: 'p' });
}

// JT3: ternary constructor line quoted inside a multi-line template body —
// phantom instance must not mint; the parameter `tq` below must stay silent.
const ternaryDoc = `Old test/live bootstrap:
const tq = flag ? new Stripe(tk) : new Stripe(lk);
delete it after migrating.`;
function shipJT(tq) {
  return tq.disputes.markJT3({ id: 'd' });
}

module.exports = { tornJT, outJT, runJT2, ternaryDoc, shipJT };
