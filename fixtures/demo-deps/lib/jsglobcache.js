// Fixture: global-cache constructor bindings (Loop 318).
// The Prisma-style hot-reload memoization idiom spelled directly on the
// global object — assign once, chain everywhere.
const Stripe = require('stripe');

// GB1: nullish lazy-init on globalThis — binds; chain must be inventoried.
globalThis._gba ??= new Stripe(process.env.KA);
const ra = globalThis._gba.payouts.flipGB1({ limit: 1 });

// GB2: plain assignment on `global` (same namespace) — binds.
global._gbb = new Stripe(process.env.KB);
const rb = global._gbb.disputes.holdGB2('dp_1');

// GB3: `&&=` only assigns when already truthy — never a construction
// guarantee; must stay silent.
globalThis._gbc &&= new Stripe(process.env.KC);
const rc = globalThis._gbc.customers.markGB3();

// GB4: reassigned from a non-proven RHS elsewhere — ambiguity guard must
// drop the field; chain must stay silent.
globalThis._gbd ||= new Stripe(process.env.KD);
globalThis._gbd = makeFake();
const rd = globalThis._gbd.invoices.bumpGB4();

// GB5: lookalike quoted in a template body — prose guard; never mints.
const note = `migration: add globalThis._gbe ??= new Stripe(k); then call globalThis._gbe.topups.pingGB5()`;
