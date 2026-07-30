// Negative site: a different provider's endpoint must never match twilio anchors,
// and a shallow single-segment path must not produce an endpoint match.
export function listProjects() {
  return fetch('https://api.vercel.com/v9/projects/main-site');
}

export function shallow() {
  return fetch('https://api.twilio.com/v2');
}
