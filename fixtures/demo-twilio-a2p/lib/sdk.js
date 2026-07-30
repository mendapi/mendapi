// Guard file: twilio-node SDK usage of the same endpoint. The SDK request
// option (a2PProfileBundleSid) and response attribute (a2pProfileBundleSid)
// are camelCase names distinct from the raw form token; the mend must leave
// every line in this file untouched.
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function registerBrandViaSdk(customerProfileSid, a2pProfileSid) {
  const brand = await client.messaging.v1.brandRegistrations.create({
    customerProfileBundleSid: customerProfileSid,
    a2PProfileBundleSid: a2pProfileSid,
  });
  return brand.a2pProfileBundleSid;
}

module.exports = { registerBrandViaSdk };
