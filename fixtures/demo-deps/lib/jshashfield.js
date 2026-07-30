// Gold fixture — Loop 361: ES2022 hash-private class fields as client holders.
// Positives: ctor-body assignment to #field, inline single-line ctor body,
// declare-and-construct #field initializer. Negatives: derived trailer,
// reassigned field (ambiguity), comment/string prose lookalikes.
import Stripe from 'stripe';

class QvBilling {
  #core;
  constructor(key) {
    this.#core = new Stripe(key);
  }
  async first() {
    await this.#core.payment_links.wakeQV1({});
  }
  async second() {
    await this.#core.tax_rates.wakeQV2();
  }
}

class QvInline {
  #api;
  constructor(key) { this.#api = new Stripe(key); }
  async run() {
    await this.#api.coupons.wakeQV3({ limit: 3 });
  }
}

class QvInit {
  #client = new Stripe(process.env.STRIPE_KEY);
  async run() {
    await this.#client.promotion_codes.wakeQV4();
  }
}

class QvDerived {
  // Negative: derived trailer — #sub holds a resource, not the client.
  #sub = new Stripe(process.env.STRIPE_KEY).charges;
  async run() {
    await this.#sub.webhook_endpoints.dropQV5();
  }
}

class QvSwap {
  #sc;
  constructor(key, other) {
    this.#sc = new Stripe(key);
    this.#sc = other; // Negative: ambiguity — reassigned, must unbind.
  }
  async run() {
    await this.#sc.apple_pay_domains.dropQV6();
  }
}

// Negative: prose lookalikes must never mint.
// this.#sc = new Stripe(key); await this.#sc.apple_pay_domains.dropQV7();
const qvDoc = 'this.#sc = new Stripe(key); await this.#sc.apple_pay_domains.dropQV8()';

export { QvBilling, QvInline, QvInit, QvDerived, QvSwap, qvDoc };
