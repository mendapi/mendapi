// Demo billing service reading PayPal Subscriptions v1 responses.
// The 2026 spec drops subscriber.address entirely (see the migration
// pack), so reads of it must be removed while shipping_address.address
// reads (the surviving delivery-address surface) are kept.
const BASE = 'https://api-m.paypal.com/v1/billing/subscriptions';

async function fetchSubscription(id, headers) {
  const res = await fetch(`${BASE}/${id}`, { headers });
  return res.json();
}

async function buildInvoiceAddress(id, headers) {
  const sub = await fetchSubscription(id, headers);
  const invoice = {
    email: sub.subscriber.email_address,
    line1: sub.subscriber.address.address_line_1,
    city: sub.subscriber.address.admin_area_2,
    street: sub.subscriber.address.address_details.street_name,
    shipCity: sub.subscriber.shipping_address.address.admin_area_2,
    shipCountry: sub.subscriber.shipping_address.address.country_code,
  };
  if (sub.subscriber.address) invoice.hasBilling = true;
  console.log(sub.subscriber?.address?.postal_code);
  return invoice;
}

module.exports = { buildInvoiceAddress };
