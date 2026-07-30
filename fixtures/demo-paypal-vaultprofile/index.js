// Demo checkout profile service reading PayPal Vault v3 payment tokens.
// The 2025-07 spec drops the extended wallet profile fields (see the
// migration pack), so reads of them must be removed while surviving
// fields (given_name, surname, core address) are kept.
const BASE = 'https://api-m.paypal.com/v3/vault';

async function fetchToken(id, headers) {
  const res = await fetch(`${BASE}/payment-tokens/${id}`, { headers });
  return res.json();
}

async function buildProfile(id, headers) {
  const token = await fetchToken(id, headers);
  const src = token.payment_source;
  const profile = {
    first: src.paypal.name.given_name,
    last: src.paypal.name.surname,
    fullName: src.paypal.name.full_name,
    honorific: src.paypal.name.prefix,
    born: src.paypal.birth_date,
    city: src.paypal.address.admin_area_2,
    district: src.paypal.address.admin_area_3,
    extra: src.paypal.address.address_details,
  };
  if (src.paypal.tax_info) profile.taxId = src.paypal.tax_info.tax_id;
  console.log(src.venmo?.name?.alternate_full_name);
  return profile;
}

async function listTokens(customerId, headers) {
  const res = await fetch(`${BASE}/payment-tokens?customer_id=${customerId}`, { headers });
  const body = await res.json();
  return body.payment_tokens.map((t) => ({
    id: t.id,
    venmoBirth: t.payment_source.venmo?.birth_date,
    country: t.payment_source.venmo?.address?.country_code,
  }));
}

module.exports = { buildProfile, listTokens };

// AST-track positive: multi-line destructuring off the paypal name
// object — full_name is a dead binding (the line-level rule honestly
// skips the entry line because it carries no wallet chain), the AST
// pass should excise full_name and collapse the pattern to the
// surviving given_name binding.
async function greetingName(id, headers) {
  const token = await fetchToken(id, headers);
  const {
    full_name,
    given_name,
  } = token.payment_source.paypal.name;
  return given_name;
}

// AST-track negative: birth_date here is referenced after binding, so
// removeDestructuredProperty must leave both lines exactly as written.
async function ageCheck(id, headers) {
  const token = await fetchToken(id, headers);
  const { birth_date, email_address } = token.payment_source.paypal;
  return { birth_date, email_address };
}

module.exports.greetingName = greetingName;
module.exports.ageCheck = ageCheck;
