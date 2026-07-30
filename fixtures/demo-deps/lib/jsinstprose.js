// Loop 296: JS constructor-instance prose guard — a constructor line quoted
// inside a multi-line template literal or a block comment (migration notes
// are the everyday carrier) must never mint a phantom instance; a same-name
// local (parameter) must stay silent. Real constructors still bind.
const Stripe = require('stripe')(process.env.STRIPE_KEY);

// JI1: declaration-form constructor quoted in a multi-line template body —
// phantom instance must not mint; the parameter `cl` below must stay silent.
const migrationDoc = `Before v12 your init looked like:
const cl = new Stripe(key);
and every call went through it.`;
function shipJI(cl) {
  return cl.charges.markJI1({ amount: 1 });
}

// JI2: deferred-form constructor quoted in a block comment body — phantom
// instance must not mint; the parameter `scq` below must stay silent.
/*
Legacy bootstrap (removed):
scq = new Stripe(key);
*/
function holdJI(scq) {
  return scq.coupons.holdJI2('c');
}

// JI3: real constructor control — still binds.
const liveJI = new Stripe(process.env.STRIPE_KEY);
const outJI = liveJI.topups.pingJI3({ amount: 2 });

module.exports = { migrationDoc, shipJI, holdJI, outJI };
