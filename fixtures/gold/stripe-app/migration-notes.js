// Gold fixture addition (Loop 292): a migration-notes file inside a real
// stripe consumer. The openai import below is COMMENT-QUOTED — the scanner
// must keep this repo at "detects only stripe" (the openai lookalike is a
// provider-level false positive if it ever matches).

// removed 2025: import OpenAI from 'openai'
/* previous integration:
   const oa = new OpenAI({ apiKey });
   fetch('https://api.openai.com/v1/models')
*/

// The stripe import in index.js is the real, uncommented binding for this repo.
module.exports = {};
