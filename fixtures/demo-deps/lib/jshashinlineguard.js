// Loop 366 gold fixture — INLINE hash-private initializer ambiguity guard.
// The Loop 365 guard was statement-start anchored; a single-line class body
// spells the same non-proven initializer inline (`{`/`;` position), which
// previously left a same-named minted field alive = false positive
// (probe-loop366 pc). Cases:
//   wakeQG1  proven statement-start initializer, consumer chain (positive)
//   dropQG2  second class, `{`-position non-proven initializer of the same
//            name -> field dropped, BOTH chains silent (double negative)
//   dropQG3  `;`-position (second member on one line) non-proven initializer
//            of a minted name -> dropped, chain silent
//   wakeQG4  inline `#gate = null;` placeholder in a second single-line
//            class must NOT drop the proven binding (Loop 325 whitelist
//            applies in inline position too) -> chain emits
const Stripe = require('stripe');

class LaneSvc {
  #lane = new Stripe(process.env.STRIPE_KEY);
  pullLanes() { return this.#lane.terminal_configurations.wakeQG1(); }
}

class MintedPair {
  #relay = new Stripe(process.env.STRIPE_KEY);
  fetchRelay() { return this.#relay.climate_products.dropQG2(); }
}
class LegacyPair { #relay = makeLegacyRelay(); grab() { return this.#relay.climate_products.dropQG2(); } }

class SplitSvc {
  #duct = new Stripe(process.env.STRIPE_KEY);
  readDuct() { return this.#duct.treasury_lane.dropQG3(); }
}
class OneLiner { label = 'x'; #duct = buildLocalDuct(); tap() { return this.#duct.treasury_lane.dropQG3(); } }

class GateSvc {
  #gate = new Stripe(process.env.STRIPE_KEY);
  openGate() { return this.#gate.payment_intents_gate.wakeQG4(); }
}
class GateShell { #gate = null; isCold() { return this.#gate === null; } }

module.exports = { LaneSvc, MintedPair, LegacyPair, SplitSvc, OneLiner, GateSvc, GateShell };
