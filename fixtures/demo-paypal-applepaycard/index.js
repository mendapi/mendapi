// Demo wallet display service reading PayPal Vault v3 apple_pay tokens.
// The 2025-07 spec contracts the apple_pay card object to a display-safe
// subset (see the migration pack), so reads of the withdrawn fields must
// be removed while surviving fields (name, last_digits, type, brand,
// billing_address) are kept.
const BASE = 'https://api-m.paypal.com/v3/vault';

async function fetchToken(id, headers) {
  const res = await fetch(`${BASE}/payment-tokens/${id}`, { headers });
  return res.json();
}

async function buildCardView(id, headers) {
  const token = await fetchToken(id, headers);
  const src = token.payment_source;
  const view = {
    holder: src.apple_pay.card.name,
    tail: src.apple_pay.card.last_digits,
    pan: src.apple_pay.card.number,
    validThru: src.apple_pay.card.expiry,
    network: src.apple_pay.card.brand,
    kind: src.apple_pay.card.card_type,
  };
  if (src.apple_pay.card.security_code) view.cvvSeen = true;
  console.log(src.apple_pay?.card?.id);
  return view;
}

async function listCards(customerId, headers) {
  const res = await fetch(`${BASE}/payment-tokens?customer_id=${customerId}`, { headers });
  const body = await res.json();
  return body.payment_tokens.map((t) => ({
    tail: t.payment_source.apple_pay?.card?.last_digits,
    expiry: t.payment_source.apple_pay?.card?.expiry,
    type: t.payment_source.apple_pay?.card?.type,
  }));
}

module.exports = { buildCardView, listCards };
