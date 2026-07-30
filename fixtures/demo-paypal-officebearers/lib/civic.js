// Anchor-gate negative site for the office-bearers AST-track pass:
// office_bearers is bound from a civic-registry row, not from a PayPal
// business_entity object. The file mentions the PayPal partner-referrals
// surface (so both file-level guards pass), which makes the anchor gate
// the only thing standing between the pack and an unrelated dead
// binding - the whole file must stay byte-identical.
const REGISTRY = 'https://registry.internal.example/companies';
const REFERRALS = 'https://api-m.paypal.com/v2/customer/partner-referrals';

async function loadCompany(companyId) {
  const res = await fetch(`${REGISTRY}/${companyId}`);
  return res.json();
}

async function companySeat(companyId) {
  const row = await loadCompany(companyId);
  const { office_bearers, seat } = row;
  return seat;
}

async function referralCount(headers) {
  const res = await fetch(REFERRALS, { headers });
  const body = await res.json();
  return body.items.length;
}

module.exports = { companySeat, referralCount };
