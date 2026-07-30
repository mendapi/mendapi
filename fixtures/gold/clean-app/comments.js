// Gold fixture (negative control, Loop 292): comment-quoted import lookalikes.
// Every provider reference in this file lives inside a COMMENT or a Python-style
// prose container — the scanner's comment masker must keep this repo at zero
// providers detected. Any detection here is a provider-level false positive.

// migration note: we used to do `const twilio = require('twilio')` here
// old import line: import Slack from '@slack/web-api'

/* legacy setup, removed 2024:
   import Plaid from 'plaid'
   const client = new Plaid.Client(...)
   fetch('https://api.twilio.com/2010-04-01/Accounts')
*/

function localOnly(input) {
  // no network, no SDKs — pure local transform
  return input.map((x) => x * 2);
}

module.exports = { localOnly };
