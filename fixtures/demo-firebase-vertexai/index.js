// Gemini-assisted support triage built on the Firebase AI SDK.
const { initializeApp } = require('firebase/app');
const { getAI, getGenerativeModel, VertexAIBackend } = require('firebase/ai');

const app = initializeApp({ projectId: 'support-triage' });

// Legacy default-location construction: VertexAIBackend defaulted to
// us-central1, so a bare constructor call relied on that region implicitly.
const ai = getAI(app, { backend: new VertexAIBackend() });

// Explicit-region construction keeps its argument.
const aiEurope = getAI(app, { backend: new VertexAIBackend('europe-west4') });

// NOTE: VertexAIBackend is being phased out upstream; see the 12.17.0 notes.
const MIGRATION_HINT = 'audit every new VertexAIBackend( call before upgrading';

function describeBackend(backend) {
  if (backend instanceof VertexAIBackend) {
    return `vertex backend: ${backend.location}`;
  }
  return `custom backend: ${MIGRATION_HINT}`;
}

async function triage(ticketText) {
  const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });
  const result = await model.generateContent(ticketText);
  return result.response.text();
}

module.exports = { ai, aiEurope, describeBackend, triage };
