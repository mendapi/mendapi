// Demo fulfilment service reading PayPal Subscriptions v1 responses.
// The 2026 spec trims subscriber.shipping_address: name keeps only
// full_name and address keeps only the six core portable fields (see
// the migration pack), so reads of the withdrawn leaves must be
// removed while surviving reads are kept byte-for-byte.
const BASE = 'https://api-m.paypal.com/v1/billing/subscriptions';

async function fetchSubscription(id, headers) {
  const res = await fetch(`${BASE}/${id}`, { headers });
  return res.json();
}

async function buildShippingLabel(id, headers) {
  const sub = await fetchSubscription(id, headers);
  const label = {
    recipient: sub.subscriber.shipping_address.name.full_name,
    honorific: sub.subscriber.shipping_address.name.prefix,
    first: sub.subscriber.shipping_address.name.given_name,
    line3: sub.subscriber.shipping_address.address.address_line_3,
    district: sub.subscriber.shipping_address.address.admin_area_3,
    street: sub.subscriber.shipping_address.address.address_details.street_name,
    city: sub.subscriber.shipping_address.address.admin_area_2,
    zip: sub.subscriber.shipping_address.address.postal_code,
    country: sub.subscriber.shipping_address.address.country_code,
  };
  if (sub.subscriber.shipping_address.address.address_details) label.hasDetails = true;
  console.log(sub.subscriber.shipping_address?.name?.alternate_full_name);
  return label;
}

module.exports = { buildShippingLabel };
