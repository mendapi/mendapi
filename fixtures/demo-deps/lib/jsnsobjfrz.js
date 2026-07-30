// Loop 370 fixture: value-identity wrapped object-literal initializers.
// `Object.freeze(...)` / `Object.seal(...)` return the same object, so a
// frozen/sealed literal declaration carries the identical construction
// proof as a bare literal (Loop 369). Arbitrary wrappers never mint.
const Stripe = require('stripe');

// wakeQD1 + wakeQD2: frozen single-line literal, two consumers.
const lockerQD = Object.freeze({ sc: new Stripe(process.env.STRIPE_KEY) });
async function wakeQD1(id) {
  return lockerQD.sc.quotes.finalizeQuote(id);
}
async function wakeQD2() {
  return lockerQD.sc.invoice_items.create({ customer: 'cus_1' });
}

// wakeQD3: sealed multi-line literal, proven property between plain props.
const cabinetQD = Object.seal({
  label: 'primary',
  sc: new Stripe(process.env.STRIPE_KEY),
  retries: 2,
});
async function wakeQD3() {
  return cabinetQD.sc.tax_settings.retrieve();
}

// dropQD4: arbitrary wrapper call — unknown return value, never mints.
const bundleQD = assembleGearQD({ sc: new Stripe(process.env.STRIPE_KEY) });
async function dropQD4() {
  return bundleQD.sc.financial_connections.sessions.create({});
}

// dropQD5: derived trailer inside a frozen literal — property holds a
// resource, not the client.
const trayQD = Object.freeze({ sc: new Stripe(process.env.STRIPE_KEY).charges });
async function dropQD5() {
  return trayQD.sc.payment_method_domains.validate('pmd_1');
}

// dropQD6: prose lookalike inside a string stays silent.
const memoQD = "const poachQD = Object.freeze({ sc: new Stripe(k) }); poachQD.sc.quotes.cancel(id)";

module.exports = { wakeQD1, wakeQD2, wakeQD3, dropQD4, dropQD5, memoQD };
