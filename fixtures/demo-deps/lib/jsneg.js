// Negative site for pyModules matchers: Python-only import syntax must never
// fire on JS files. `import boto3 ...` here is a local helper import, and a
// bare `github` identifier is a local variable — neither may create an aws or
// github module surface.
import boto3 from './boto3-helper.js';

const github = { repos: { list: () => [] } };

// Python from-import syntax inside a JS string must never create a binding:
// extractSdkCalls only consults the from-import path for .py files. The
// parenthesized multi-line form must be gated identically.
const snippet = `
from openai import OpenAI
`;
const parenSnippet = `
from anthropic import (
    Anthropic,
)
`;
const OpenAI = { chat: { completions: { create: () => null } } };
const Anthropic = { messages: { create: () => null } };

// Ruby require syntax inside a JS string must never create a module surface
// or a Ruby constant binding (rbOnly matcher + isRb gate):
const rubySnippet = "require 'twilio-ruby'\nStripe::Charge.create(x)";

export function localOnly() {
  const ai = OpenAI;
  const bot = Anthropic;
  return { helper: boto3, repos: github.repos.list(), snippet, parenSnippet, noop: ai.chat.completions.create(), noop2: bot.messages.create() };
}
