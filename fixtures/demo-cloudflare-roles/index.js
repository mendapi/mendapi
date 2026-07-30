// Sync tool that mirrors Cloudflare account role assignments into the local
// directory service. Talks to the legacy account roles listing endpoint.
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN;

async function cf(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Cloudflare API ${res.status}`);
  return res.json();
}

async function findAdminRole(acct) {
  const roles = await cf(`/accounts/${acct}/roles`);
  return roles.result.find((r) => r.description === 'Administrator');
}

async function listAuditRoles(acct) {
  const roles = await cf(`/accounts/${acct}/roles`);
  return roles.result.filter((r) => r.description.startsWith('Audit'));
}

async function getRole(acct, roleId) {
  return cf(`/accounts/${acct}/roles/${roleId}`);
}

// Zone-level notes are a different collection with its own description
// field; the remap must never touch reads outside the fetched result shape.
function summarize(role, zoneNotes) {
  const note = zoneNotes.find((n) => n.id === role.id);
  return `${role.id}: ${note ? note.description : 'no note'}`;
}

module.exports = { findAdminRole, listAuditRoles, getRole, summarize };
