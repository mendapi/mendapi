// Deps-inventory gold fixture: raw REST consumer with endpoint surfaces that
// intersect monitored change anchors (twilio Attempts/Summary rename #3455).
export async function attemptsSummary(sid) {
  return fetch(`https://api.twilio.com/v2/Attempts/Summary?VerifyServiceSid=${sid}`);
}

// unrelated shallow host reference: must inventory as api-host, not endpoint
const TWILIO_BASE = 'https://api.twilio.com';
export { TWILIO_BASE };
