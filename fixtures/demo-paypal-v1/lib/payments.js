// Payments flows on 1.x positional signatures, plus guard negatives:
// a local dispatcher whose same-named methods take positional args but are
// not SDK controllers, and an already-migrated 2.0.0-style call that the
// mend must leave byte-identical (idempotency surface).
const { client } = require('./client');

const { paymentsController } = client;

async function settle(authorizationId) {
  const { result: auth } = await paymentsController.getAuthorizedPayment(authorizationId);
  if (auth.status === 'CREATED') {
    await paymentsController.reauthorizePayment(authorizationId, undefined, 'return=minimal', undefined, { amount: auth.amount });
  }
  const { result } = await paymentsController.captureAuthorizedPayment(authorizationId, undefined, undefined, undefined, undefined, { finalCapture: true });
  return result;
}

async function cancel(authId) {
  await paymentsController.voidPayment(authId);
}

async function refundFlow(captureId, note) {
  const { result: capture } = await paymentsController.getCapturedPayment(captureId);
  const { result: refund } = await paymentsController.refundCapturedPayment(captureId, undefined, undefined, undefined, undefined, { noteToPayer: note });
  // Already-migrated call site (2.0.0 shape): must stay untouched.
  const { result: check } = await paymentsController.getRefund({ refundId: refund.id });
  return { capture, refund, check };
}

// Guard negative: a local dispatcher with positional same-named helpers.
// No paypal controller anchor, so the mend must leave these untouched.
const dispatcher = {
  getRefund(id, source) { return { id, source }; },
  voidPayment(id) { return { id, voided: true }; },
};

function auditEntry(id) {
  return [dispatcher.getRefund(id, 'ledger'), dispatcher.voidPayment(id)];
}

module.exports = { settle, cancel, refundFlow, auditEntry };
