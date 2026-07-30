// Loop 363 fixture: guarded-if lazy-init construction with ES2022
// hash-private field targets — the composition of the Loop 320/321
// guarded-if matchers and the Loop 361 hash-private ruling (`#` is only a
// field spelling; the guard/assign backreference proof is identical).
const Stripe = require('stripe');

// wakeQA1/wakeQA2: bang-guard form, two consumers on the same hash field.
class QaLedger {
  #sc;
  ensure(key) {
    if (!this.#sc) this.#sc = new Stripe(key);
    return this.#sc;
  }
  credits() { return this.#sc.treasury_credits.wakeQA1({}); }
  quotesFx() { return this.#sc.fx_quotes.wakeQA2({}); }
}

// wakeQA3: null-comparison guard form.
class QaTransfers {
  #api = null;
  boot(key) {
    if (this.#api === null) this.#api = new Stripe(key);
  }
  reversals() { return this.#api.transfer_reversals.wakeQA3({}); }
}

// wakeQA4: undefined-comparison guard form.
class QaCaps {
  #core;
  warm(key) {
    if (this.#core === undefined) this.#core = new Stripe(key);
  }
  caps() { return this.#core.capability_updates.wakeQA4({}); }
}

// dropQA5: derived trailer in the guarded assignment — never the client.
class QaDerived {
  #ch;
  ensure(key) {
    if (!this.#ch) this.#ch = new Stripe(key).charges;
    return this.#ch.dropQA5({});
  }
}

// dropQA6: guard field differs from the assigned field — structural
// rejection (the backreference never matches), and the consumer field was
// never proven.
class QaMismatch {
  #left; #right;
  ensure(key) {
    if (!this.#left) this.#right = new Stripe(key);
    return this.#right.customers.dropQA6({});
  }
}

// dropQA7: prose lookalikes — commented and quoted guarded-if lines never
// mint a binding.
// if (!this.#px) this.#px = new Stripe(key); this.#px.invoices.dropQA7()
const qaDoc = "if (!this.#py) this.#py = new Stripe(key); this.#py.quotes.dropQA7()";

module.exports = { QaLedger, QaTransfers, QaCaps, QaDerived, QaMismatch, qaDoc };
