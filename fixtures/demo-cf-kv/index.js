// Demo app calling the legacy Cloudflare Workers KV namespace routes.
// Cloudflare deprecated these paths on 2026-07-15; they stop working on
// 2026-10-15. The replacement is a direct URL path substitution.
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

async function listNamespaces() {
  return cf(`/accounts/${ACCOUNT}/workers/namespaces`);
}

async function createNamespace(title) {
  return cf(`/accounts/${ACCOUNT}/workers/namespaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

async function listKeys(namespaceId) {
  return cf(`/accounts/${ACCOUNT}/workers/namespaces/${namespaceId}/keys`);
}

module.exports = { listNamespaces, createNamespace, listKeys };
