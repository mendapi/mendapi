// Demo checkout flow using @paypal/paypal-server-sdk 0.6.x. In 0.7.0/1.0.0
// every controller method was renamed (create-order family) while keeping
// positional signatures, so pre-0.7.0 call sites break at compile/run time.
const { Client, Environment } = require('@paypal/paypal-server-sdk');

const client = new Client({
  environment: Environment.Sandbox,
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
});

async function createCheckoutOrder(orderRequest) {
  const { result } = await client.ordersController.ordersCreate({ body: orderRequest });
  return result;
}

async function confirmAndCapture(orderId, paymentSource) {
  await client.ordersController.ordersConfirm({ id: orderId, body: { paymentSource } });
  const { result } = await client.ordersController.ordersCapture({ id: orderId, prefer: 'return=representation' });
  return result;
}

async function inspectOrder(orderId) {
  const { result } = await client.ordersController.ordersGet({ id: orderId });
  return result.status;
}

async function amendOrder(orderId, patch) {
  await client.ordersController.ordersPatch({ id: orderId, body: patch });
}

async function addTracking(orderId, tracker) {
  await client.ordersController.ordersTrackCreate({ id: orderId, body: tracker });
  await client.ordersController.ordersTrackersPatch({ id: orderId, trackerId: tracker.id, body: [] });
}

module.exports = { createCheckoutOrder, confirmAndCapture, inspectOrder, amendOrder, addTracking };
