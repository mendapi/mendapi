// Gold fixture: a repo that implements a custom HTTP client for stripe-node.
// It touches the Stripe.HttpClient type surface, so change #134 (HttpClient
// types exported as interfaces instead of classes) must be reported HIGH.
// It touches no other changed stripe surface, so every other stripe
// breaking/deprecation change must stay MEDIUM (import evidence only).
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-05-28',
});

/** @type {Stripe.HttpClient} */
let customHttpClient = null;

/** @returns {Stripe.HttpClientResponse} */
function makeResponse(raw) {
  return raw;
}

async function charge(amountCents) {
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
  });
  return intent.id;
}

module.exports = { charge, makeResponse, customHttpClient };
