// Demo compliance service reading PayPal Subscriptions v1 responses.
// The 2026 spec drops the subscriber PII fields birth_date and tax_info
// (see the migration pack), so reads of them must be removed while
// surviving sibling fields (email_address, name, phone) are kept.
const BASE = 'https://api-m.paypal.com/v1/billing/subscriptions';

async function fetchSubscription(id, headers) {
  const res = await fetch(`${BASE}/${id}`, { headers });
  return res.json();
}

async function buildTaxRecord(id, headers) {
  const sub = await fetchSubscription(id, headers);
  const record = {
    email: sub.subscriber.email_address,
    surname: sub.subscriber.name.surname,
    dob: sub.subscriber.birth_date,
    taxId: sub.subscriber.tax_info.tax_id,
    taxIdType: sub.subscriber.tax_info.tax_id_type,
  };
  if (sub.subscriber.tax_info) record.hasTaxProfile = true;
  console.log(sub.subscriber?.birth_date);
  return record;
}

module.exports = { buildTaxRecord };

// AST-track positive: multi-line destructuring off the subscriber
// object — birth_date is a dead binding (the line-level rule honestly
// skips the entry line because it carries no subscriber chain), the
// AST pass should excise birth_date and collapse the pattern to the
// surviving email_address binding.
async function contactEmail(id, headers) {
  const sub = await fetchSubscription(id, headers);
  const {
    birth_date,
    email_address,
  } = sub.subscriber;
  return email_address;
}

// AST-track negative: tax_info here is referenced after binding, so
// removeDestructuredProperty must leave both lines exactly as written.
async function taxSnapshot(id, headers) {
  const sub = await fetchSubscription(id, headers);
  const { tax_info, email_address } = sub.subscriber;
  return { tax_info, email_address };
}

module.exports.contactEmail = contactEmail;
module.exports.taxSnapshot = taxSnapshot;
