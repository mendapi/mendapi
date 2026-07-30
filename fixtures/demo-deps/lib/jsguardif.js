// Loop 320: guarded-if lazy-init construction — the classic pre-`??=`
// memoization spelling (`if (!client) client = new Stripe(key);`).
// Binds only when the guard operand is THE SAME name as the assignment
// target (bare falsy check or null/undefined equality); compound
// conditions and mismatched targets stay AST track.
const Stripe = require('stripe');

// GF1: bare falsy guard, same-operand — binds; the chain below must be
// inventoried.
let lazyGF = null;
if (!lazyGF) lazyGF = new Stripe(process.env.STRIPE_KEY);
const outGF = lazyGF.payouts.flipGF1({ amount: 7 });

// GF2: null-equality guard, same-operand — binds; the chain below must be
// inventoried.
let eqGF = null;
if (eqGF === null) eqGF = new Stripe(process.env.STRIPE_KEY);
const outGF2 = eqGF.disputes.holdGF2({ id: 'd' });

// GF3: DIFFERENT assignment target — the guard proves nothing about the
// assigned name, must NOT bind; the chain stays silent (AST track).
let mixGF = null;
if (!mixGF) otherGF = new Stripe(process.env.STRIPE_KEY);
function runGF3() {
  return mixGF.plans.markGF3({ id: 'p' });
}

// GF4: COMPOUND condition — the guard is not a bare same-operand check,
// must NOT bind (honest skip); the chain stays silent.
let condGF = null;
if (readyGF() && !condGF) condGF = new Stripe(process.env.STRIPE_KEY);
function readyGF() { return false; }
function runGF4() {
  return condGF.invoices.bumpGF4({ id: 'i' });
}

// GF5: guarded-if line quoted inside a multi-line template body — phantom
// instance must not mint; the parameter `gfq` below must stay silent.
const docGF = `Legacy bootstrap:
if (!gfq) gfq = new Stripe(k);
delete after migrating to ??=`;
function shipGF(gfq) {
  return gfq.coupons.pingGF5({ id: 'c' });
}

module.exports = { lazyGF, outGF, eqGF, outGF2, runGF3, runGF4, docGF, shipGF };
