// Demo service using the legacy openai-node v3 SDK (pre-v4 breaking change).
// Docs note: openai.createChatCompletion({...}) was the v3 entry point.
const { Configuration, OpenAIApi } = require('openai');

// This string mentions the legacy call and must never be rewritten by the fixer:
const LEGACY_HINT = 'if you still call openai.createChatCompletion( upgrade to v4';
const AUDIT_LOG_LINE = `migrating away from .createEmbedding( for tenant`;

const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

async function summarize(text) {
  const response = await openai.createChatCompletion({
    model: 'gpt-4',
    messages: [{ role: 'user', content: `Summarize: ${text}` }],
  });
  return response.data.choices[0].message.content;
}

async function embed(text) {
  const response = await openai.createEmbedding({
    model: 'text-embedding-ada-002',
    input: text,
  });
  return response.data.data[0].embedding;
}

module.exports = { summarize, embed };
