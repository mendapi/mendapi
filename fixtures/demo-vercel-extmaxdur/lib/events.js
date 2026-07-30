// Event webhook consumers for the Vercel project event feed.
// The extended-max-duration event type was discontinued upstream in
// v1.28.0, so its subscription entries and single-line consumers must
// be removed.
const WATCHED_EVENTS = [
  'project-created',
  'project-functions-extended-max-duration-updated',
  'project-removed',
];

function summarizeEvents(events) {
  const summary = { renamed: 0, durationToggles: 0 };
  for (const event of events) {
    if (event.type === 'project-renamed') summary.renamed += 1;
    if (event.type === 'project-functions-extended-max-duration-updated') summary.durationToggles += 1;
  }
  return summary;
}

function describePayload(event) {
  const lines = [`project ${event.payload.projectId}`];
  lines.push(`extended: ${event.payload.enableFunctionsExtendedMaxDuration}`);
  lines.push(`actor: ${event.payload.userId}`);
  return lines.join('\n');
}

module.exports = { WATCHED_EVENTS, summarizeEvents, describePayload };
