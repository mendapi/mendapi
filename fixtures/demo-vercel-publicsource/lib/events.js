// Event webhook consumers for the Vercel project event feed.
// The project event payload STILL carries the source-visibility field as
// a required boolean after v1.28.0, so every payload read in this file
// must be preserved byte-identical by the mend.
function describeProjectEvent(event) {
  const lines = [`project ${event.payload.projectId} (${event.payload.projectName})`];
  lines.push(`source visible: ${event.payload.publicSource}`);
  return lines.join('\n');
}

function countPublicProjects(events) {
  let publicCount = 0;
  for (const event of events) {
    if (event.payload.publicSource === true) publicCount += 1;
  }
  return publicCount;
}

module.exports = { describeProjectEvent, countPublicProjects };
