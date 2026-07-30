// Controller-style sdk-call fixture: instances constructed from a *named*
// import (new OrdersController(client)) must yield controller-call surfaces
// carrying ctor + real variable name, and `mendapi deps --match` must join
// them to the paypal 1.0.0 rename pack only when ctor, anchor variable, and
// legacy method name all agree.
import { Client, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';

const client = new Client({ environment: 'sandbox' });
const ordersController = new OrdersController(client);
const paymentsController = new PaymentsController(client);

export async function placeOrder(orderRequest) {
  // legacy 0.x method name: must join the rename pack (#627)
  return ordersController.ordersCreate(orderRequest);
}

export async function lookupRefund(refundId) {
  // already-migrated 1.0.0 name: not in the pack's legacy method list,
  // must never join (the fix would not touch this line)
  return paymentsController.getRefund(refundId);
}

// Negative site: same ctor but non-standard variable name — the fixer's
// rules anchor on the literal `ordersController.` chain, so this call is
// NOT rewritten by the pack and must never join.
const legacyOrders = new OrdersController(client);
export async function legacyLookup(id) {
  return legacyOrders.ordersGet(id);
}
