// Vercel Marketplace integration: experimentation protocol settings sync.
const BASE = 'https://api.vercel.com';

async function pushExperimentationConfig(icId, resourceId, body, headers) {
  // marketplace write path under the removed family
  const res = await fetch(
    `${BASE}/v1/installations/${icId}/resources/${resourceId}/experimentation/edge-config`,
    { method: 'PUT', headers, body: JSON.stringify(body) },
  );
  return res.json();
}

module.exports = { pushExperimentationConfig };
