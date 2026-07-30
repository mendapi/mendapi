// JS constructor trailing-chain adjudication (Loop 338).
// All JS binding matchers previously stopped at the constructor's opening
// paren — `const sc = new Stripe(k).charges` bound `sc` as the CLIENT while
// it actually holds a derived resource (false attribution, the JS mirror of
// the Ruby Loop 337 hole). Ruling: after the constructor call's balanced
// close, a member trailer (`.` / `?.`) drops the binding (AST track); a TS
// non-null postfix is value-identity and keeps it.
const Stripe = require('stripe');

// CT1: plain construction, no trailer — binds (control).
const ctPlain = new Stripe(process.env.CT_KEY);
ctPlain.skus.wakeCT1({ limit: 1 });

// CT2: derived-resource trailer on the declaration — the var holds
// charges, NOT the client. Binding must drop; consumer stays silent.
const ctRes = new Stripe(process.env.CT_KEY).charges;
ctRes.ephemeral_keys.dropCT2({});

// CT3: derived trailer on the deferred assignment — silent.
let ctDef;
ctDef = new Stripe(process.env.CT_KEY).accounts;
ctDef.ephemeral_keys.dropCT3({});

// CT4: derived trailer on the memoized fallback — silent.
const ctFb = globalThis._ct ?? new Stripe(process.env.CT_KEY).balance;
ctFb.ephemeral_keys.dropCT4({});

// CT5: multi-line argument list with a derived trailer on the close line —
// the walk crosses lines and still sees the trailer. Silent.
const ctMl = new Stripe(
  process.env.CT_KEY
).charges;
ctMl.ephemeral_keys.dropCT5({});

// CT6: multi-line argument list, clean close — binds (control).
const ctMlOk = new Stripe(
  process.env.CT_KEY
);
ctMlOk.account_links.wakeCT6({});
