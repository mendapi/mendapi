// Chained-assignment binding fixture (Loop 349).
//
// JS assignment is an expression: `const a = b = new Ctor(k)` (and the
// deferred `a = b = new Ctor(k)`) binds BOTH names to the same constructed
// client. Two-target forms bind; derived trailers, 3+ targets and prose
// lookalikes stay silent.
const Stripe = require('stripe');

// QJ1/QJ2 (positive): declaration chained assignment — both names consume.
const qjOuter = qjInner = new Stripe('sk_test_1');
qjOuter.setup_attempts.wakeQJ1('seti_1');
qjInner.file_links.wakeQJ2('link_1');

let qjA, qjB;
function initChained(key) {
  // QJ3/QJ4 (positive): deferred chained assignment — both names consume.
  qjA = qjB = new Stripe(key);
}
qjA.setup_attempts.wakeQJ3('seti_2');
qjB.file_links.wakeQJ4('link_2');

// QJ5/QJ6 (negative): derived-object trailer after the balanced close —
// neither name holds the client (Loop 338 verdict carries over).
const qjDv = qjDw = new Stripe('sk_test_2').charges;
qjDv.dropQJ5('ch_1');
qjDw.dropQJ6('ch_2');

// QJ7 (negative): 3+ targets are an honest skip (AST track).
let qjX, qjY, qjZ;
qjX = qjY = qjZ = new Stripe('sk_test_3');
qjX.dropQJ7('x_1');

// QJ8 (negative): a chained assignment quoted in a template-literal body
// must never mint an instance.
const qjUsage = `
example:
  sx = cx = new Stripe(key);
  sx.forwarding.dropQJ8('fr_1');
`;

module.exports = { initChained, qjUsage };
