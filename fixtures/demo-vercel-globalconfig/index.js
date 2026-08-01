// Edge Config management-API consumer against api.vercel.com.
// Raw REST URL builders are the breakage surface for the v1.28.14
// edge-config -> global-config path family rename.
const BASE = 'https://api.vercel.com';

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) throw new Error(`vercel request failed: ${res.status}`);
  return res.json();
}

async function listConfigs(headers) {
  // collection route: /v1/edge-config
  return api('/v1/edge-config', { headers });
}

async function readItems(configId, headers) {
  // nested item routes under the removed family
  const items = await api(`/v1/edge-config/${configId}/items`, { headers });
  const schema = await api(`/v1/edge-config/${configId}/schema`, { headers });
  return { items, schema };
}

async function restoreBackup(configId, versionId, headers) {
  return api(`/v1/edge-config/${configId}/backups/${versionId}/restore`, {
    method: 'POST',
    headers,
  });
}

// Already migrated: successor path must be left untouched (idempotency /
// partial-migration safety).
async function listConfigsNew(headers) {
  return api('/v1/global-config', { headers });
}

module.exports = { listConfigs, readItems, restoreBackup, listConfigsNew };
