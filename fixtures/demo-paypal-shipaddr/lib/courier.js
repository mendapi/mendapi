// Courier manifest helper on the PayPal Subscriptions v1 surface
// (api-m.paypal.com /v1/billing/subscriptions). The address_details
// binding below is destructured off the shipping_address.address chain
// AND is referenced by the return value, so the reference-counting
// primitive must leave the whole pattern untouched even though the
// token is withdrawn by the spec trim.
function manifestExtras(sub) {
  const { address_details, postal_code } = sub.subscriber.shipping_address.address;
  return { address_details, postal_code };
}

module.exports = { manifestExtras };
