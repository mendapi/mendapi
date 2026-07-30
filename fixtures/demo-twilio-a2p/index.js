// Demo app registering A2P brands via the raw Twilio Messaging REST API.
// The BrandRegistrations form parameter changed casing between spec versions
// 1.20.0 and 1.30.0; older integrations still send the legacy-cased key and
// the API rejects the request as missing a required parameter.
const BASE = 'https://messaging.twilio.com';
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;

async function twilioPost(path, form) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Twilio API ${res.status}`);
  return res.json();
}

async function registerBrand(customerProfileSid, a2pProfileSid) {
  const form = new URLSearchParams();
  form.set('CustomerProfileBundleSid', customerProfileSid);
  form.set('A2pProfileBundleSid', a2pProfileSid);
  return twilioPost('/v1/a2p/BrandRegistrations', form);
}

async function registerBrandInline(customerProfileSid, a2pProfileSid) {
  const body = `CustomerProfileBundleSid=${customerProfileSid}&A2pProfileBundleSid=${encodeURIComponent(a2pProfileSid)}`;
  const res = await fetch(`${BASE}/v1/a2p/BrandRegistrations`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.json();
}

module.exports = { registerBrand, registerBrandInline };
