// Gold fixture — Loop 364: TS typed class fields and setter hand-offs with
// ES2022 hash-private names. The Loop 361 ruling verbatim: `#` is just the
// field spelling; the tsc-enforced type annotation (typed declaration /
// typed setter param) is the same proof as the public form.
import Stripe from 'stripe';

// Positive: hash-private TYPED DECLARATION + DI constructor hand-off.
// `#gw: Stripe;` is only legal inside a class body — the annotation proves
// what the field holds at every assignment site.
class QbBilling {
  #gw: Stripe;
  constructor(gw: Stripe) { this.#gw = gw; }
  async ids() { return this.#gw.tax_ids.wakeQB1({}); }
  async fx() { return this.#gw.exchange_rates.wakeQB2(); }
}

// Positive: single-line class body — the `{`-prefixed inline declaration
// position of the same typed-field proof.
class QbInline { #pay: Stripe; constructor(p: Stripe) { this.#pay = p; } go() { return this.#pay.file_links.wakeQB3({}); } }

// Positive: setter injection — an UNTYPED hash-private field proven by the
// typed setter parameter and the pure hand-off assignment.
class QbSetter {
  #core;
  setClient(sc: Stripe): void { this.#core = sc; }
  attempts() { return this.#core.setup_attempts.wakeQB4({}); }
}

// Negative: setter-proven hash field REASSIGNED from a non-proven RHS —
// the ambiguity guard unbinds it (never guess what the field holds).
class QbSwap {
  #alt;
  setAlt(alt: Stripe): void { this.#alt = alt; }
  rewire(x: unknown) { this.#alt = x; }
  drop() { return this.#alt.account_links.dropQB5({}); }
}

// Negative: prose lookalikes never mint a field.
// class FakeQb { #gw: Stripe; }
const qbNote = 'class FakeQb2 { #phantom: Stripe; } this.#phantom = sc;';
export function dropQB6(): number { return qbNote.length; }

export { QbBilling, QbInline, QbSetter, QbSwap };
