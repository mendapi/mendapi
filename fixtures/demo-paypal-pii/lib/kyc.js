// Internal KYC profile store. This file never talks to the PayPal API,
// so its same-named PII leaves on a local subscriber object must be
// left byte-for-byte untouched by the migration pack (file-level guard
// negative site).
const profiles = new Map();

function recordKyc(customerId, subscriber) {
  profiles.set(customerId, {
    dob: subscriber.birth_date,
    taxId: subscriber.tax_info.tax_id,
    taxIdType: subscriber.tax_info.tax_id_type,
  });
}

function hasTaxData(customerId) {
  const p = profiles.get(customerId);
  return Boolean(p && p.taxId);
}

module.exports = { recordKyc, hasTaxData };
