// Loop 321: guarded-if lazy-init on a this-field — the field spelling of
// the classic pre-`??=` memoization idiom
// (`if (!this.sc) this.sc = new Stripe(key);`). Binds only when the guard
// operand is THE SAME field as the assignment target (bare falsy check or
// null/undefined equality); compound conditions and mismatched targets
// stay AST track.
const Stripe = require('stripe');

// TG1: bare falsy guard, same-operand field — binds; the chain below must
// be inventoried.
class BillingTG {
  charge(key) {
    if (!this.tga) this.tga = new Stripe(key);
    return this.tga.payouts.flipTG1({ amount: 7 });
  }
}

// TG2: null-equality guard, same-operand field — binds; the chain below
// must be inventoried.
class LedgerTG {
  settle(key) {
    if (this.tgb === null) this.tgb = new Stripe(key);
    return this.tgb.disputes.holdTG2({ id: 'd' });
  }
}

// TG3: DIFFERENT assignment target — the guard proves nothing about the
// assigned field, must NOT bind; the chain stays silent (AST track).
class MirrorTG {
  probe(key) {
    if (!this.tgc) this.tgcOther = new Stripe(key);
    return this.tgc.plans.markTG3({ id: 'p' });
  }
}

// TG4: COMPOUND condition — the guard is not a bare same-operand check,
// must NOT bind (honest skip); the chain stays silent.
class GateTG {
  open(key) {
    if (this.readyTG() && !this.tgd) this.tgd = new Stripe(key);
    return this.tgd.invoices.bumpTG4({ id: 'i' });
  }
  readyTG() { return false; }
}

// TG5: guarded-if line quoted inside a multi-line template body — phantom
// field must not mint; the chain below must stay silent.
const docTG = `Legacy bootstrap:
if (!this.tge) this.tge = new Stripe(k);
delete after migrating to ??=`;
class QuoteTG {
  ship() {
    return this.tge.coupons.pingTG5({ id: 'c' });
  }
}

// TG6 (Loop 325): constructor null-init placeholder + guarded-if — the
// canonical class-based lazy-init pairing. The bare `= null` placeholder
// is whitelisted (it means "not yet constructed"), so the proven
// guarded-if binding survives and the chain below must be inventoried.
class LazyTG {
  constructor() {
    this.tgf = null;
  }
  poll(key) {
    if (!this.tgf) this.tgf = new Stripe(key);
    return this.tgf.balance.wakeTG6({ id: 'b' });
  }
}

// TG7 (Loop 325): conditional null RHS is NOT the bare placeholder — the
// field may hold a different construction, so the ambiguity guard must
// still drop the proven binding; the chain stays silent.
class RiskyTG {
  constructor(flag) {
    this.tgg = flag ? null : makeOtherTG();
  }
  poll(key) {
    if (!this.tgg) this.tgg = new Stripe(key);
    return this.tgg.balance.dropTG7({ id: 'b' });
  }
}
function makeOtherTG() { return null; }

module.exports = { BillingTG, LedgerTG, MirrorTG, GateTG, docTG, QuoteTG, LazyTG, RiskyTG };
