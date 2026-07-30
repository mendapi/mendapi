// Internal loyalty-wallet ledger (no payments-provider context, no vault surface).
// Field names overlap with the Apple Pay card shape, but this module
// talks to the in-house loyalty service only. The migration pack must
// leave this file byte-identical.
const LEDGER = 'https://ledger.internal.example/wallets';

async function loadWallet(memberId) {
  const res = await fetch(`${LEDGER}/${memberId}`);
  return res.json();
}

async function summarize(memberId) {
  const wallet = await loadWallet(memberId);
  return {
    pan: wallet.apple_pay.card.number,
    validThru: wallet.apple_pay.card.expiry,
    kind: wallet.apple_pay.card.card_type,
    ref: wallet.apple_pay?.card?.id,
  };
}

module.exports = { summarize };
