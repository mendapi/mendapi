// Anchor-gate negative site for the wallet-profile AST-track pass:
// birth_date and full_name are bound from an in-house staff roster
// row, not from a paypal/venmo wallet object. The file mentions the
// PayPal vault payment-tokens surface (so both file-level guards
// pass), which makes the per-group anchor gate the only thing
// standing between the pack and an unrelated dead binding — the
// whole file must stay byte-identical.
const ROSTER = 'https://roster.internal.example/staff';
const VAULT = 'https://api-m.paypal.com/v3/vault/payment-tokens';

async function loadStaff(staffId) {
  const res = await fetch(`${ROSTER}/${staffId}`);
  return res.json();
}

async function staffGreeting(staffId) {
  const row = await loadStaff(staffId);
  const { full_name, team } = row;
  return team;
}

async function staffAge(staffId) {
  const row = await loadStaff(staffId);
  const { birth_date, badge } = row;
  return badge;
}

async function tokenCount(customerId, headers) {
  const res = await fetch(`${VAULT}?customer_id=${customerId}`, { headers });
  const body = await res.json();
  return body.payment_tokens.length;
}

module.exports = { staffGreeting, staffAge, tokenCount };
