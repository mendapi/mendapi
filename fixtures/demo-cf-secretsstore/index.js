// Legacy Cloudflare secrets-store consumer hitting the removed /system alias
// routes. The 2026-07-27 OAS drops the whole legacy system-alias store
// family; the canonical /accounts/{account_id}/secrets_store routes carry the
// identical method sets.
const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_API_TOKEN;

async function cf(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Cloudflare API ${res.status}`);
  return res.json();
}

async function listStores() {
  return cf(`/system/accounts/${ACCOUNT}/stores`);
}

async function deleteStore(storeId) {
  return cf(`/system/accounts/${ACCOUNT}/stores/${storeId}`, { method: 'DELETE' });
}

async function createSecret(storeId, name, value) {
  return cf(`/system/accounts/${ACCOUNT}/stores/${storeId}/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name, value, scopes: ['workers'] }]),
  });
}

async function duplicateSecret(storeId, secretId, name) {
  return cf(`/system/accounts/${ACCOUNT}/stores/${storeId}/secrets/${secretId}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

// Already migrated: the canonical family must survive untouched
// (idempotency / partial-migration safety).
async function listStoresCanonical() {
  return cf(`/accounts/${ACCOUNT}/secrets_store/stores`);
}

module.exports = { listStores, deleteStore, createSecret, duplicateSecret, listStoresCanonical };
