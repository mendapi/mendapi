// Anchor-gate negative site: this in-house receipt printer helper for the
// PayPal Orders v2 checkout flow names both file-level guard tokens
// (paypal + payment_source below), and its pix binding is genuinely dead —
// but it comes off an in-house printer profile row, so the payment_source
// anchor gate is the only defence. The whole file must stay byte-identical.
const SOURCE_KEY = 'payment_source';

const printerProfiles = {
  receipt: { pix: 180, dpi: 203 },
};

function receiptLabel() {
  const { pix, dpi } = printerProfiles.receipt;
  return `thermal receipt profile via ${SOURCE_KEY}`;
}

module.exports = { receiptLabel };
