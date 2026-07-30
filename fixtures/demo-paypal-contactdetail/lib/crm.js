// Internal CRM contact book. No PayPal context anywhere in this file:
// the same-named leaves on unrelated records must never be rewritten.

function primaryPhone(record) {
  const hit = record.phones[0];
  return {
    number: hit.national_number,
    label: hit.contact_name,
    isPrimary: record.phones[0].primary,
  };
}

function activeAddresses(record) {
  return record.addresses.filter((a) => !record.addresses[0].inactive && a.primary);
}

module.exports = { primaryPhone, activeAddresses };
