// Sample invoicing integration talking to the PayPal Invoicing v2 API
// (https://api-m.paypal.com/v2/invoicing). Reads the send-invoice 202 body.

async function sendAndTrack(client, invoiceId) {
  const res = await client.post(`/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
  // Wrapper reads on the proven send receiver: all three leaves must unwrap.
  const statusUrl = res.links[0].href;
  const relName = res.links?.[0].rel;
  console.log('poll via', res.links[0]?.method, statusUrl, relName);
  return statusUrl;
}

async function sendViaHelper(invoiceId) {
  const outcome = await sendInvoice(invoiceId);
  // Optional-chain form on a helper-bound receiver must unwrap too.
  return outcome?.links[0].href;
}

function navigate(invoice) {
  // Navigation links on a NON-send receiver keep the wrapper shape:
  // these reads must never be touched.
  const first = invoice.links[0].href;
  const second = invoice.links[1].href;
  const found = invoice.links.find((l) => l.rel === 'self')?.href;
  return [first, second, found];
}

function sendInvoice(id) { return fetch(`/v2/invoicing/invoices/${id}/send`, { method: 'POST' }).then((r) => r.json()); }

module.exports = { sendAndTrack, sendViaHelper, navigate };
