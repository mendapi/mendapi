// Marketplace integration resource inspector against api.vercel.com
const BASE = 'https://api.vercel.com';

async function fetchJson(url, opts) {
  const res = await fetch(`${BASE}${url}`, opts);
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

async function experimentationStatus(icId, resourceId, headers) {
  // legacy single-resource read of the experimentation protocol settings
  const resource = await fetchJson(`/v1/installations/${icId}/resources/${resourceId}`, { headers });
  const syncing = resource.protocolSettings.experimentation.edgeConfigSyncingEnabled;
  const tokenId = resource.protocolSettings.experimentation.edgeConfigTokenId;
  return { syncing, tokenId };
}

module.exports = { experimentationStatus, fetchJson };
