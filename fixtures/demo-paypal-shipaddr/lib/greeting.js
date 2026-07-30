// Greeting-card helper on the PayPal Subscriptions v1 surface
// (api-m.paypal.com /v1/billing/subscriptions). Both file-level guards
// pass, but every destructuring pattern here binds off
// sub.subscriber.name — the SURVIVING subscriber.name object, which
// keeps given_name/surname while shipping_address.name is trimmed to
// full_name. The anchor gate (.shipping_address.name chain required)
// is the only defence keeping this file byte-identical: the prefix
// binding below is dead code, yet it must never be removed because the
// pattern is not anchored to the shipping_address.name chain.
function greetingLine(sub) {
  const { prefix, given_name } = sub.subscriber.name;
  return `Dear ${given_name}`;
}

module.exports = { greetingLine };
