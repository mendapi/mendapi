// Billing lookups over the same installation surface. This module reads
// only fields that survive on the single-resource endpoint, so the mend
// must leave every line byte-identical.
const { fetchJson } = require('../index.js');

async function billingPlan(icId, resourceId, headers) {
  const resource = await fetchJson(`/v1/installations/${icId}/resources/${resourceId}`, { headers });
  return { plan: resource.billingPlanId, status: resource.status };
}

module.exports = { billingPlan };
