// Reporting helper built on the twilio-node SDK. The attempts-summary fetch
// options object still uses the legacy option key.
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function dailySummary(verifySid) {
  return client.verify.v2.verificationAttemptsSummary.fetch({
    serviceSid: verifySid,
    channel: 'sms',
  });
}

// Guard check: the services resource keeps its own serviceSid-style usage and
// verification creation options are a different surface; both stay untouched.
async function startVerification(serviceSid, to) {
  return client.verify.v2.services(serviceSid).verifications.create({ to, channel: 'sms' });
}

module.exports = { dailySummary, startVerification };
