// Demo onboarding service talking to PayPal Partner Referrals v2.
// The 2026 spec removes the whole business_entity.office_bearers
// subtree (the office_bearer schema itself is gone, no successor), so
// writes and reads of it must be removed while the surviving sibling
// beneficial_owners list is kept untouched.
const BASE = 'https://api-m.paypal.com/v2/customer/partner-referrals';

async function createReferral(operations, names, officers, owners, headers) {
  const payload = {
    operations,
    business_entity: {
      names,
      office_bearers: officers.map(toBearer),
      beneficial_owners: owners,
    },
  };
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(payload) });
  return res.json();
}

async function summarizeReferral(id, headers) {
  const res = await fetch(`${BASE}/${id}`, { headers });
  const data = await res.json();
  const summary = {
    owners: data.referral_data.business_entity.beneficial_owners,
    firstBearerRole: data.referral_data.business_entity.office_bearers[0].role,
  };
  if (data.referral_data.business_entity.office_bearers) summary.hasBearers = true;
  console.log(data.referral_data.business_entity?.office_bearers);
  return summary;
}

function toBearer(officer) {
  return { role: officer.role };
}

module.exports = { createReferral, summarizeReferral };
