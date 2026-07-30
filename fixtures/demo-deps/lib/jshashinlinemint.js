// Loop 367 gold fixture — INLINE hash-private initializer MINTING.
// Loop 361 minting was statement-start anchored; a single-line class body
// spells the same proven initializer inline (`{`/`;` position), which was
// an honest miss (probe-loop367 pa/pe). The Loop 366 ambiguity guard was
// already inline-aware; this round adds the symmetric minting. Cases:
//   wakeQH1  `{`-position proven inline initializer, consumer chain (positive)
//   wakeQH2  `;`-position (second member on one line) proven initializer,
//            consumer chain (positive)
//   wakeQH3  multi-member one-liner: proven inline mint in class A plus an
//            unrelated class B with a DIFFERENT field name — A's chain emits
//   dropQH4  inline proven mint in class A + inline NON-proven same-named
//            initializer in class B -> guard drops, BOTH chains silent
//   dropQH5  template-literal prose lookalike of an inline initializer —
//            never mint, chain silent
//   dropQH6  same-line `//` comment before the inline initializer — the
//            inlineProseGuard rejects the mint, chain silent
const Stripe = require('stripe');

class InletSvc { #mast = new Stripe(process.env.STRIPE_KEY); hoist() { return this.#mast.siren_meters.wakeQH1(); } }

class CoveSvc { tag = 'cove'; #keel = new Stripe(process.env.STRIPE_KEY); scrape() { return this.#keel.lane_fees.wakeQH2(); } }

class ReefSvc { #buoy = new Stripe(process.env.STRIPE_KEY); float() { return this.#buoy.harbor_credits.wakeQH3(); } }
class ShoalSvc { #anchorRope = tieRope(); moor() { return this.#anchorRope.plain_rope.pull(); } }

class HullGood { #hull = new Stripe(process.env.STRIPE_KEY); scan() { return this.#hull.pier_topups.dropQH4(); } }
class HullBad { #hull = makeLegacyKeel(); rust() { return this.#hull.pier_topups.dropQH4(); } }

const DOC = `
class Ghost { #wisp = new Stripe(key); drift() { return this.#wisp.mist_banks.dropQH5(); } }
`;

class Deck { walk() { return 1; } } // class Note { #plank = new Stripe(k); step() { return this.#plank.gull_counts.dropQH6(); } }

module.exports = { InletSvc, CoveSvc, ReefSvc, ShoalSvc, HullGood, HullBad, DOC, Deck };
