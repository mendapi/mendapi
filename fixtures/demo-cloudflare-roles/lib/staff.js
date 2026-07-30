// Internal HR directory client. Completely unrelated staffing service that
// happens to expose an accounts/roles route shape of its own; the migration
// pack must leave every line of this file untouched.
const HR_API = process.env.HR_API_BASE;

async function hr(path) {
  const res = await fetch(`${HR_API}${path}`);
  return res.json();
}

async function staffRoles(accountId) {
  const roles = await hr(`/accounts/${accountId}/roles`);
  return roles.result.find((r) => r.description === 'Manager');
}

module.exports = { staffRoles };
