// Sample invoicing integration talking to the PayPal Invoicing v2 API
// (https://api-m.paypal.com/v2/invoicing). Error handlers below dispatch on
// the HATEOAS links returned inside error bodies.

async function cancelInvoice(client, invoiceId) {
  const res = await client.delete(`/v2/invoicing/invoices/${invoiceId}`);
  if (res.status >= 400) {
    const err = await res.json();
    for (const errLink of err.links) {
      if (errLink.method === 'CONNECT') continue;
      if (errLink.method === 'HEAD' || errLink.method === 'OPTIONS') continue;
      followErrorLink(errLink);
    }
    // survivor: dispatch on a documented verb must stay
    const retry = err.links.find((l) => l.method === 'POST');
    if (err.links[0].method === 'OPTIONS') return null;
    if (retry) return followErrorLink(retry);
  }
  return res;
}

function navigate(invoice) {
  // navigation links (non-error) keep the full 8-value enum: these
  // dispatches must never be touched even though they name the verbs.
  for (const link of invoice.links) {
    if (link.method === 'HEAD') continue;
    if (link.method === 'OPTIONS') continue;
    visit(link);
  }
}

function followErrorLink(l) { return l.href; }
function visit(l) { return l.href; }

module.exports = { cancelInvoice, navigate };
