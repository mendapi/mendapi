// Legacy stripe-node v7 usage: global setters configured after construction.
const stripe = require('stripe')(process.env.STRIPE_KEY);
stripe.setApiVersion('2019-12-03');
stripe.setMaxNetworkRetries(2);

async function createCustomer(email) {
  return stripe.customers.create({ email });
}

async function chargeCustomer(customerId, amount) {
  return stripe.paymentIntents.create({
    customer: customerId,
    amount,
    currency: 'usd',
    confirm: true,
  });
}

module.exports = { createCustomer, chargeCustomer };
