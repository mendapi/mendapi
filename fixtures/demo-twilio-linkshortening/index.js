// Demo integration that configures a Twilio LinkShortening domain over raw REST.
// The domain-config endpoint stopped accepting the messaging-service fields;
// associations now live on dedicated LinkShortening endpoints.
const DOMAIN_SID = process.env.TWILIO_DOMAIN_SID;
const BASE = 'https://messaging.twilio.com/v1';

async function updateDomainConfig(auth, serviceSids) {
  const form = new URLSearchParams();
  form.set('FallbackUrl', 'https://example.com/expired');
  form.set('MessagingServiceSids', serviceSids.join(','));
  form.set('CallbackUrl', 'https://example.com/clicks');
  form.append('MessagingServiceSidsAction', 'ADD');

  const res = await fetch(`${BASE}/LinkShortening/Domains/${DOMAIN_SID}/Config`, {
    method: 'POST',
    headers: { Authorization: auth },
    body: form,
  });
  return res.json();
}

async function updateDomainConfigJsonShaped(auth) {
  const body = {
    FallbackUrl: 'https://example.com/expired',
    MessagingServiceSids: ['MG00000000000000000000000000000001'],
    MessagingServiceSidsAction: 'REPLACE',
    CallbackUrl: 'https://example.com/clicks',
  };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    form.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  const res = await fetch(`${BASE}/LinkShortening/Domains/${DOMAIN_SID}/Config`, {
    method: 'POST',
    headers: { Authorization: auth },
    body: form,
  });
  return res.json();
}

module.exports = { updateDomainConfig, updateDomainConfigJsonShaped };
