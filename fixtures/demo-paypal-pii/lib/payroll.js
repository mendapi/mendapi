// Anchor-gate negative site for the subscriber-pii AST-track pass:
// birth_date and tax_id are bound from an in-house payroll row, not
// from a PayPal subscriber object. The file mentions the PayPal
// billing subscriptions surface (so both file-level guards pass),
// which makes the per-group anchor gate the only thing standing
// between the pack and an unrelated dead binding — the whole file
// must stay byte-identical.
const PAYROLL = 'https://payroll.internal.example/staff';
const SUBS = 'https://api-m.paypal.com/v1/billing/subscriptions';

async function loadStaff(staffId) {
  const res = await fetch(`${PAYROLL}/${staffId}`);
  return res.json();
}

async function staffBadge(staffId) {
  const row = await loadStaff(staffId);
  const { birth_date, badge } = row;
  return badge;
}

async function staffDesk(staffId) {
  const row = await loadStaff(staffId);
  const { tax_id, desk } = row;
  return desk;
}

async function subscriptionCount(planId, headers) {
  const res = await fetch(`${SUBS}?plan_id=${planId}`, { headers });
  const body = await res.json();
  return body.subscriptions.length;
}

module.exports = { staffBadge, staffDesk, subscriptionCount };
