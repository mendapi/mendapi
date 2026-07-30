// Survivor surface: PayPal Orders v2 consumers reading sibling payment
// sources. The card and paypal branches of payment_source survive the
// swish/pix removal, so every line in this file must be preserved
// byte-identical by the mend.
async function summarizePayment(order) {
  const source = order.payment_source;
  if (source.card) {
    return { kind: 'card', brand: source.card.brand, lastDigits: source.card.last_digits };
  }
  if (source.paypal) {
    return { kind: 'paypal', email: source.paypal.email_address };
  }
  return { kind: 'unknown' };
}

module.exports = { summarizePayment };
