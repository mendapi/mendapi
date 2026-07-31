// In-house inference shim that reuses the VertexAIBackend name but has no
// relationship to the Firebase AI SDK (no firebase/ai import). The context
// guard must keep this file byte-identical.
class VertexAIBackend {
  constructor(location) {
    this.location = location || 'on-prem';
  }
}

function localBackend() {
  return new VertexAIBackend();
}

module.exports = { VertexAIBackend, localBackend };
