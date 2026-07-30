// Internal HR org-chart store. This file never talks to the PayPal API,
// so its same-named office_bearers reads on a local company object must
// be left byte-for-byte untouched by the migration pack (file-level
// guard negative site).
const companies = new Map();

function recordCompany(companyId, company) {
  companies.set(companyId, {
    bearers: company.business_entity.office_bearers,
    chair: company.business_entity.office_bearers[0],
  });
}

function listBearers(companyId) {
  const c = companies.get(companyId);
  return c ? c.bearers : [];
}

module.exports = { recordCompany, listBearers };
