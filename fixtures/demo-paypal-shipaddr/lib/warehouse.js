// Internal warehouse manifest service. No PayPal context: reads of a
// local order's shipping_address object must never be rewritten even
// when the leaf tokens match the withdrawn PayPal fields.
function manifestRow(order) {
  return {
    honorific: order.shipping_address.name.prefix,
    district: order.shipping_address.address.admin_area_3,
    street: order.shipping_address.address.address_details.street_name,
  };
}

module.exports = { manifestRow };
