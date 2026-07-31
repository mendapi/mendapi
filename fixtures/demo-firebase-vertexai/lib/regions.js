// Partially migrated module: the import list already carries the successor
// class next to the legacy one. After the mend the destructuring list must
// contain AgentPlatformBackend exactly once (no duplicate binding).
const { getAI, VertexAIBackend, AgentPlatformBackend } = require('firebase/ai');

function backendFor(app, region) {
  if (region === 'global') return getAI(app, { backend: new AgentPlatformBackend() });
  // template-literal mention of the legacy name must survive untouched:
  const label = `falling back to VertexAIBackend region ${region}`;
  console.log(label);
  return getAI(app, { backend: new VertexAIBackend(region) });
}

module.exports = { backendFor };
