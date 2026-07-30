// Demo app pulling Twilio Verify attempt summaries via the raw REST API.
// The summary endpoint renamed its filter query parameter between spec
// versions 1.30.0 and 1.40.0; older integrations still send the legacy name
// and silently lose the filter.
const BASE = 'https://verify.twilio.com';
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

async function twilioGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`Twilio API ${res.status}`);
  return res.json();
}

async function attemptsSummaryForService(verifySid, country) {
  return twilioGet(`/v2/Attempts/Summary?ServiceSid=${verifySid}&Country=${country}`);
}

async function attemptsSummaryByChannel(verifySid, channel) {
  return twilioGet('/v2/Attempts/Summary?' + `ServiceSid=${verifySid}&Channel=${channel}`);
}

// Guard check: ServiceSid stays valid as a path parameter on the Services
// resource; the mend must leave this line alone.
async function listEntities(serviceSid) {
  return twilioGet(`/v2/Services/${serviceSid}/Entities`);
}

module.exports = { attemptsSummaryForService, attemptsSummaryByChannel, listEntities };
