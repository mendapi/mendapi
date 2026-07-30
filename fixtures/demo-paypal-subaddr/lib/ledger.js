// Billing ledger snapshots for PayPal Subscriptions v1
// (https://api-m.paypal.com/v1/billing/subscriptions). The address
// binding below is still referenced, so even though its pattern is
// anchored to the subscriber chain the AST pass must leave it alone.
function billingSnapshot(sub) {
  const { address, email_address } = sub.subscriber;
  return { address, email_address };
}

module.exports = { billingSnapshot };
