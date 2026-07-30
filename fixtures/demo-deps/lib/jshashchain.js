// Gold fixture — Loop 362: chained assignment with hash-private targets.
// Positives: field-first (`this.#sc = client = new Stripe(k)`), var-first
// (`client = this.#sc = ...`), field-to-field with hash on one or both
// sides. Negatives: derived trailer, three targets, prose lookalikes.
import Stripe from 'stripe';

class QxBilling {
  #core;
  constructor(key) {
    this.#core = qxLocal = new Stripe(key);
  }
  async first() {
    await this.#core.climate_orders.wakeQX1({});
  }
  async second() {
    await qxLocal.terminal_locations.wakeQX2();
  }
}

class QxGateway {
  #api;
  constructor(key) {
    qxVar = this.#api = new Stripe(key);
  }
  async run() {
    await this.#api.credit_grants.wakeQX3({ limit: 3 });
    await qxVar.verification_reports.wakeQX4();
  }
}

class QxMirror {
  #prime; alias; #twin; #pair;
  constructor(key, k2) {
    this.#prime = this.alias = new Stripe(key);
    this.#twin = this.#pair = new Stripe(k2);
  }
  async run() {
    await this.#prime.payment_method_configs.wakeQX5();
    await this.#twin.confirmation_tokens.wakeQX6();
  }
}

class QxDerived {
  #sub;
  constructor(key) {
    this.#sub = qxRes = new Stripe(key).charges;
  }
  async run() {
    await this.#sub.climate_orders.dropQX7();
  }
}

class QxTriple {
  #sc;
  constructor(key) {
    this.#sc = qxA = qxB = new Stripe(key);
  }
  async run() {
    await this.#sc.terminal_locations.dropQX8();
  }
}

// Negative: prose lookalikes must never mint.
// this.#sc = client = new Stripe(key); await client.credit_grants.dropQX9();
const qxDoc = 'this.#sc = client = new Stripe(key); await client.credit_grants.dropQX9()';

export { QxBilling, QxGateway, QxMirror, QxDerived, QxTriple, qxDoc };
