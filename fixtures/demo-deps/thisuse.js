// Class-property constructor binding fixture (Loop 203): the service-class
// idiom — a client constructed onto `this.<field>` in the constructor, then
// consumed through `this.<field>.<chain>()` in methods.
const Stripe = require('stripe');

class PaymentService {
  constructor(key) {
    this.stripe = new Stripe(key);
  }

  // Positive: field-rooted chain binds via the this-field map.
  async charge(amount) {
    return this.stripe.charges.createTC1({ amount });
  }
}

class LazyService {
  ensure(key) {
    this.sc ??= new Stripe(key);
  }

  // Positive: logical lazy-init spelling on a this-field also binds.
  async cancel(id) {
    return this.sc.payouts.cancelTC2(id);
  }
}

// Negative: same field name reassigned from a non-proven RHS anywhere in the
// file drops the field (ambiguity guard) — badTC3 must stay silent.
class MixedA {
  constructor(k) {
    this.dual = new Stripe(k);
  }
}
class MixedB {
  constructor(other) {
    this.dual = other;
  }
  bad() {
    return this.dual.charges.badTC3({});
  }
}

// Negative: `&&=` is never a lazy-init construction — badTC4 stays silent.
class AndService {
  ensure(k) {
    this.andField &&= new Stripe(k);
  }
  bad() {
    return this.andField.charges.badTC4({});
  }
}

// Negative: field assigned without `new` from a non-proven callee — badTC5
// stays silent; single segment past the field (`this.stripeLike.pingTC6()`)
// has no chain to attribute and stays silent too.
class PlainService {
  constructor() {
    this.mailer = makeMailer();
  }
  bad() {
    return this.mailer.messages.badTC5({});
  }
  ping() {
    return this.stripe.pingTC6(1);
  }
}

// Negative: comment / string lookalikes never bind.
// this.ghost = new Stripe(key) in a comment
const note = 'this.ghost2 = new Stripe(key) in a string';
function ghost() {
  return this.ghost2.charges.badTC7({});
}

// --- Loop 212: single-line method-body / inline positions ---

// Positive: assignment inside a single-line constructor body binds — the `{`
// before it is an unambiguous statement boundary in JS grammar.
class OneLiner {
  constructor(k) { this.olc = new Stripe(k); }
  pay(a) { return this.olc.invoices.payIL1(a); }
}

// Positive: second statement on the same line (after `;`) also binds.
class TwoStmt {
  constructor(k) { this.count = 0; this.ts = new Stripe(k); }
  refund(id) { return this.ts.transfers.createIL2(id); }
}

// Negative: inline lookalike inside a string stays silent (prose guard) —
// badIL3 must not bind.
const ilnote = 'demo { this.ils = new Stripe(k); } demo';
function ilghost() {
  return this.ils.charges.badIL3({});
}

// Negative: inline commented lookalike stays silent — badIL4 must not bind.
// usage: constructor(k) { this.ilcm = new Stripe(k); }
function ilghost2() {
  return this.ilcm.charges.badIL4({});
}

// Negative: inline proven assignment PLUS a second non-proven inline
// assignment to the same field drops it (guard reaches inline positions) —
// badIL5 must not bind.
class InlineMixed {
  constructor(k) { this.im = new Stripe(k); }
  swap(o) { this.im = o; }
  bad() { return this.im.charges.badIL5({}); }
}

module.exports = { PaymentService, LazyService, MixedA, MixedB, AndService, PlainService, ghost, note, OneLiner, TwoStmt, ilnote, ilghost, ilghost2, InlineMixed };
