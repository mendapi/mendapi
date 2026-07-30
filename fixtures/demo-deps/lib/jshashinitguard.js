// Loop 365 fixture: file-level ambiguity guard for HASH-PRIVATE class-field
// INITIALIZER targets — the `#` twin of the Loop 232 initializer guard.
// A `#field = new <proven binding>(...)` initializer mints the field
// (Loop 361), but a same-named `#field = <non-proven RHS>` initializer in
// another class of the same file must DROP it (file-level scope: never
// guess which class a `this.#field` chain belongs to). The Loop 325
// null-placeholder whitelist applies: `#field = null;` never drops a
// proven guarded-if binding.
const Stripe = require('stripe');

// Positive control: proven initializer, no competing write anywhere.
// A commented lookalike below must never drop it (line anchor rejects it):
// #qnGood = legacyGateway();
class QnGoodSvc {
  #qnGood = new Stripe(process.env.STRIPE_KEY);
  async pull(id) {
    return this.#qnGood.climate_suppliers.wakeQN1(id);
  }
}

// Guard case: proven in one class, NON-proven initializer of the SAME
// hash-field name in another class -> field dropped file-wide, BOTH
// consumers stay silent (the safe direction).
class QnDupProven {
  #qnDup = new Stripe(process.env.STRIPE_KEY);
  async pull(id) {
    return this.#qnDup.billing_credit_grants.dropQN2(id);
  }
}
class QnDupOther {
  #qnDup = makeLegacyGateway();
  async pull(id) {
    return this.#qnDup.forwarding_requests.dropQN3(id);
  }
}

// Null-placeholder whitelist: `#qnLazy = null;` is "not yet constructed",
// it must NOT drop the proven guarded-if binding (Loop 325 analog).
class QnLazySvc {
  #qnLazy = null;
  async pull(id) {
    if (!this.#qnLazy) this.#qnLazy = new Stripe(process.env.STRIPE_KEY);
    return this.#qnLazy.tax_registrations.wakeQN4(id);
  }
}

module.exports = { QnGoodSvc, QnDupProven, QnDupOther, QnLazySvc };
