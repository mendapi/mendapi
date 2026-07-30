// Referenced negative site: the pix binding below is anchored to
// payment_source (the AST-track anchor gate passes), but the identifier is
// referenced later in the file, so removeDestructuredProperty's reference
// count is the only defence — every line here must stay byte-identical.
async function auditPayment(order) {
  const {
    pix,
    card,
  } = order.payment_source;
  return { pix, card };
}

module.exports = { auditPayment };
