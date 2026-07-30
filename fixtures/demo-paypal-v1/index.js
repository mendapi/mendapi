// Demo checkout flow using @paypal/paypal-server-sdk 1.x positional
// signatures. In 2.0.0 every controller method wraps its positional
// parameters into a single options object (requestOptions stays positional),
// so these call sites break at compile/run time after the upgrade.
const { Client, Environment } = require('@paypal/paypal-server-sdk');

const client = new Client({
  environment: Environment.Sandbox,
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
});

const { ordersController } = client;

async function createCheckoutOrder(orderRequest, requestId) {
  // Positional with skipped optionals: body, mockResponse, requestId.
  const { result } = await ordersController.createOrder(orderRequest, undefined, requestId);
  return result;
}

async function captureWithPrefer(orderId) {
  // id, mock, requestId, prefer — a string literal containing a comma-free
  // value but exercising the arg-name inference (id !== orderId).
  const { result } = await ordersController.captureOrder(orderId, undefined, undefined, 'return=representation');
  return result;
}

async function inspectOrder(id) {
  // Single positional arg whose name matches the parameter: shorthand form.
  const { result } = await ordersController.getOrder(id);
  return result.status;
}

async function amendOrder(id, patchBody, requestOptions) {
  // Full-arity call: trailing requestOptions must stay positional.
  await ordersController.patchOrder(id, undefined, undefined, patchBody, requestOptions);
}

async function addTracking(id, tracker) {
  // Nested object literal argument with commas — bracket-depth splitter test.
  await ordersController.createOrderTracking(id, { carrier: tracker.carrier, trackingNumber: tracker.number });
}

module.exports = { createCheckoutOrder, captureWithPrefer, inspectOrder, amendOrder, addTracking };
