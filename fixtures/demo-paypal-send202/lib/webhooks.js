// Internal delivery webhook fan-out. No PayPal context anywhere in this
// file: same-shaped links[0] reads must stay byte-identical (pack guard).

function firstEndpoint(job) {
  const primary = job.links[0].href;
  const verb = job.links[0]?.method;
  return { primary, verb };
}

function dispatch(job) {
  const target = firstEndpoint(job);
  return { url: target.primary, method: target.verb || 'POST' };
}

module.exports = { firstEndpoint, dispatch };
