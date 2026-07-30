// Key/value helpers built on the legacy KV namespace routes, including a
// plain-concatenation URL style (no template literal) to exercise both forms.
const BASE = 'https://api.cloudflare.com/client/v4/accounts/';

function valueUrl(accountId, namespaceId, keyName) {
  return BASE + accountId + '/workers/namespaces/' + namespaceId + '/values/' + encodeURIComponent(keyName);
}

async function getValue(accountId, namespaceId, keyName, token) {
  const res = await fetch(valueUrl(accountId, namespaceId, keyName), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed: ${res.status}`);
  return res.text();
}

async function putValue(accountId, namespaceId, keyName, value, token) {
  const res = await fetch(valueUrl(accountId, namespaceId, keyName), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV write failed: ${res.status}`);
  return res.json();
}

async function getMetadata(accountId, namespaceId, keyName, token) {
  const url = `${BASE}${accountId}/workers/namespaces/${namespaceId}/metadata/${encodeURIComponent(keyName)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`KV metadata failed: ${res.status}`);
  return res.json();
}

module.exports = { getValue, putValue, getMetadata };
