// Gold fixture: a repo using the OpenAI SDK's ActionSearch surface.
// Change #80 (v6.40.0: "fix ActionSearch.query to be optional") touches
// ActionSearch, which this file uses -> must be reported HIGH.
// Other openai changes (e.g. #23 service account API keys) are not
// touched here -> must stay MEDIUM (import evidence only).
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildActionSearch(query) {
  // Uses the ActionSearch shape whose `query` field changed optionality.
  const search = { type: 'ActionSearch', query };
  return search;
}

async function complete(prompt) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content;
}

module.exports = { complete, buildActionSearch };
