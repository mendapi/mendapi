// Delivery labels built from PayPal Subscriptions v1 responses
// (https://api-m.paypal.com/v1/billing/subscriptions). The surviving
// shipping_address.address surface anchors a different member chain:
// even a dead address binding pulled off shipping_address must never
// be rewritten by the subscriber.address pack.
function deliveryName(sub) {
  const { address, name } = sub.subscriber.shipping_address;
  return name.full_name;
}

module.exports = { deliveryName };
