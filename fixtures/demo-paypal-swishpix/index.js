// Demo checkout service talking to the PayPal Orders v2 API.
// The swish and pix payment sources were removed from the Orders v2 spec
// entirely (2026-04): those branches and their schemas no longer exist.
// Requests carrying them are rejected and responses never include them,
// so every branch write and read below must be deleted while sibling
// payment sources survive.
const TOKEN = process.env.PAYPAL_TOKEN;
const BASE = 'https://api-m.paypal.com';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`paypal api ${res.status}`);
  return res.json();
}

async function createSwishOrder(units, name) {
  return api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: units,
    payment_source: { swish: { name, country_code: 'SE' }, paypal: { experience_context: { locale: 'sv-SE' } } },
  });
}

async function createPixOrder(units, email) {
  return api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: units,
    payment_source: { pix: { country_code: 'BR', email_address: email } },
  });
}

async function describeOrder(id) {
  const order = await api('GET', `/v2/checkout/orders/${id}`);
  const { swish, pix, card } = order.payment_source;
  const summary = { id: order.id, status: order.status, hasCard: Boolean(card) };
  if (order.payment_source.swish) summary.qr = order.payment_source.swish.qr_data;
  if (order.payment_source.pix) summary.pixExpiry = order.payment_source.pix.qr_details.qr_expiry;
  return summary;
}

module.exports = { createSwishOrder, createPixOrder, describeOrder };
