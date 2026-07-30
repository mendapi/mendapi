// Anchor-gate negative site for the AST-track pass: id and number are
// bound from an in-house reader-registry row, not from the Apple Pay
// card object. The file mentions the PayPal vault payment-tokens
// surface (so both file-level guards pass), which makes the anchor
// gate the only thing standing between the pack and an unrelated dead
// binding — the whole file must stay byte-identical.
const REGISTRY = 'https://registry.internal.example/readers';
const VAULT = 'https://api-m.paypal.com/v3/vault/payment-tokens';

async function loadRow(readerId) {
  const res = await fetch(`${REGISTRY}/${readerId}`);
  return res.json();
}

async function readerLabel(readerId) {
  const row = await loadRow(readerId);
  const { id, label } = row;
  return label;
}

async function tokenCount(customerId, headers) {
  const res = await fetch(`${VAULT}?customer_id=${customerId}`, { headers });
  const body = await res.json();
  return body.payment_tokens.length;
}

module.exports = { readerLabel, tokenCount };
