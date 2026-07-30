// Internal CRM directory service. No PayPal context: reads of a local
// newsletter subscriber's address object must never be rewritten.
function mailingLabel(subscriber) {
  return {
    line1: subscriber.address.address_line_1,
    city: subscriber.address.admin_area_2,
    zip: subscriber.address.postal_code,
  };
}

function labelFor(record) {
  return record.subscriber.address.admin_area_1;
}

module.exports = { mailingLabel, labelFor };
