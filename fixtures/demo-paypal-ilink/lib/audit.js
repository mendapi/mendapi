// Support audit log for vault payment-tokens error responses. The
// legacy documentation field is still forwarded verbatim into the audit
// record here, so the binding is referenced and the migration pack must
// leave this file byte-identical (reference counting is the only line
// of defense: the file passes both PayPal and vault context guards).
function auditEntry(err) {
  const { information_link, debug_id } = err;
  return { information_link, debug_id, at: Date.now() };
}

module.exports = { auditEntry };
