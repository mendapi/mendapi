// Firewall for AI settings consumer. The 2026-07-27 Cloudflare OAS renames
// the product path segment (firewall-for-ai becomes ai-security) with
// identical method sets on every route.
const API = 'https://api.cloudflare.com/client/v4';

async function getSettings(cf, zoneId) {
  return cf(`${API}/zones/${zoneId}/firewall-for-ai/settings`);
}

async function putCustomTopics(cf, zoneId, topics) {
  return cf(`${API}/zones/${zoneId}/firewall-for-ai/custom-topics`, {
    method: 'PUT',
    body: JSON.stringify({ topics }),
  });
}

module.exports = { getSettings, putCustomTopics };
