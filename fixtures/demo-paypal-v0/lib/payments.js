// Payments side of the demo: authorization/capture/refund flows on the
// legacy 0.6.x method names, plus a guard negative site — a local ledger
// object exposing same-named helpers that must never be rewritten because
// they are not anchored on a controller member chain.
const { client } = require('./client');

async function settleAuthorization(authorizationId) {
  const { result: auth } = await client.paymentsController.authorizationsGet({ authorizationId });
  if (auth.status === 'CREATED') {
    await client.paymentsController.authorizationsReauthorize({ authorizationId, body: {} });
  }
  const { result } = await client.paymentsController.authorizationsCapture({ authorizationId, body: { finalCapture: true } });
  return result;
}

async function cancelAuthorization(authorizationId) {
  await client.paymentsController.authorizationsVoid({ authorizationId });
}

async function refundFlow(captureId) {
  const { result: capture } = await client.paymentsController.capturesGet({ captureId });
  const { result: refund } = await client.paymentsController.capturesRefund({ captureId, body: { noteToPayer: 'Order cancelled' } });
  const { result: check } = await client.paymentsController.refundsGet({ refundId: refund.id });
  return { capture, refund, check };
}

// Guard negative: an internal ledger with legacy-shaped helper names. No
// controller chain anchor, so the mend must leave these untouched.
const ledger = {
  authorizationsGet(id) { return { id, source: 'ledger' }; },
  capturesRefund(id) { return { id, refunded: true }; },
};

function auditEntry(id) {
  return [ledger.authorizationsGet(id), ledger.capturesRefund(id)];
}

module.exports = { settleAuthorization, cancelAuthorization, refundFlow, auditEntry };
