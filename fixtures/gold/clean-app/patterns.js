// Negative control (Loop 294): provider lookalikes inside a REGEX PATTERN
// are prose, not code — they must never mint a provider detection. A URL
// matcher quoting an old import line is the daily carrier.
const migrated = raw.match(/used to be import stripe from 'stripe' here/);
const legacy = note.replace(/const openai = require\('openai'\)/, 'gone');
module.exports = function checkPatterns(x) { return migrated || legacy || x; };
