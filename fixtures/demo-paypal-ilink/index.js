// Demo vault client with error handling for PayPal Vault v3 payment tokens.
// The 2025-07 spec removes the legacy documentation field from error
// bodies (see the migration pack), so reads of it must be removed while
// surviving error fields (name, message, debug_id, details, links) are
// kept.
const BASE = 'https://api-m.paypal.com/v3/vault';

async function deleteToken(id, headers) {
  const res = await fetch(`${BASE}/payment-tokens/${id}`, { method: 'DELETE', headers });
  if (!res.ok) {
    const err = await res.json();
    const summary = {
      code: err.name,
      msg: err.message,
      docs: err.information_link,
      trace: err.debug_id,
    };
    if (err.information_link) summary.hasDocs = true;
    console.log(err.information_link);
    return summary;
  }
  return null;
}

async function createToken(payload, headers) {
  const res = await fetch(`${BASE}/payment-tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    return {
      failed: true,
      reason: body.message,
      help: body?.information_link,
      issues: body.details,
      links: body.links,
    };
  }
  return body;
}

module.exports = { deleteToken, createToken };
