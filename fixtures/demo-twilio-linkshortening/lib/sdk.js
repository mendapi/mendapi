// twilio-node SDK surface for the same domain-config update. The update
// options for the messaging-service association were dropped alongside the
// REST parameters; keeping them sends dead fields.
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function configureDomain(domainSid, serviceSids) {
  return client.messaging.v1.domainConfig(domainSid).update({
    fallbackUrl: 'https://example.com/expired',
    messagingServiceSids: serviceSids,
    messagingServiceSidsAction: 'ADD',
    callbackUrl: 'https://example.com/clicks',
  });
}

// Guard site: an unrelated builder with a similarly named option must stay
// untouched (it is not a domainConfig update call chain).
function buildLocalPlan(serviceSids) {
  return {
    messagingServiceSids: serviceSids,
    messagingServiceSidsAction: 'REPLACE',
    note: 'local planning object, not an API request',
  };
}

module.exports = { configureDomain, buildLocalPlan };
