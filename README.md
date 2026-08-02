# mendapi

> **Dependabot, but for every API you depend on.**
> We watch your upstream API providers for breaking changes, scan your codebase for impact, and open the fix PR before your integration breaks.

## 30 seconds to your first result

```bash
# In any repo — zero config, zero npm dependencies, nothing leaves your machine
npx mendapi scan
```

You get every upstream breaking change that actually hits your code — file, line, and symbol — scored for confidence. Then `npx mendapi fix` drafts the migration as a reviewable diff.

Using an AI coding agent? One line plugs mendapi into Claude Code as an MCP server (Cursor and every other MCP client work too — [details below](#use-it-from-your-ai-coding-agent-mcp)):

```bash
claude mcp add mendapi -- npx mendapi mcp
```

Requires Node.js 22+. Everything runs locally: the scanner, fixer, and review CLIs contain no network code at all.

## Security model (read this first)

This tool is designed for teams that cannot let source code leave their machines. The security model is the product, not a FAQ entry:

1. **Your code never leaves your machine.** The scanner runs locally or in your CI. Nothing is uploaded by default — there is no network code in the scanner, fixer, or review CLIs at all (mechanically enforced by our test suite, which fails the build if any network primitive appears in those files).
2. **Metadata-only reporting, opt-in only.** If you ever choose to report results to a hosted dashboard, the payload builder (`payload.js`) is whitelist-constructed: provider names, SDK versions, file basenames, line numbers, and symbol names only. Code snippets are structurally impossible to include — the field does not exist in the payload schema. Reporting requires an explicit `--report-to` flag; it is never on by default.
3. **Secrets are redacted in depth.** Fifteen secret patterns (OpenAI, Stripe, AWS, GitHub, Slack, JWT, bearer tokens, generic key assignments, and more) are scrubbed from every field of any outbound payload, and a pre-transmission assertion throws if a forbidden key or unredacted secret survives.
4. **Auditable by design.** The CLI is open source so your security team can verify, line by line, exactly what is read and what (if anything) is sent.
5. **Minimal GitHub permissions.** Fix PRs use a GitHub App scoped to `contents:read` + `pull_requests:write` on repos you choose. Never admin.
6. **Self-hosting available.** Enterprise plans run the entire stack — change feed included — inside your firewall.

## What it does

Three components form a closed loop:

| Component | Role | Where it runs |
|-----------|------|---------------|
| **Watcher** | Monitors 20 major API providers (Stripe, OpenAI, Anthropic, Shopify, Twilio, Slack, GitHub, Google, AWS, Plaid, PayPal, Meta, Cloudflare, Vercel, Supabase, Firebase, Notion, HubSpot, Salesforce, SendGrid) via SDK release feeds and official developer changelogs. Classifies each change (breaking / deprecation / additive / fix / docs-only) into a structured SQLite database. | Our infrastructure (or yours, self-hosted) |
| **Scanner** | Reads the change database, detects which providers your repo actually uses (SDK imports, API hosts, env vars — context-aware, not naive grep), and pinpoints the exact files, lines, and symbols affected by each breaking change. Three-tier confidence scoring plus an optional LLM semantic review pass keeps false positives near zero. | **Locally, on your machine or CI** |
| **Fixer** | Applies deterministic migration rule packs (e.g. `openai-v3-to-v4`, `stripe-v7-to-v8`) to produce a reviewable diff, then opens a fix PR on a dedicated branch with the official migration guide cited in the commit message. | Locally by default; hosted for paid plans |

## Quickstart

Requires Node.js 22+ (uses built-in `node:sqlite`). Zero npm dependencies.

```bash
# Fetch the latest API change feed (the only command that touches the network)
mendapi sync

# Scan the current repo against the breaking-change database (zero config)
mendapi scan

# Or scan a specific repo and save the report
mendapi scan --repo /path/to/your/repo --out impact.json

# Review medium-confidence findings (optional LLM semantic pass)
mendapi review impact.json --pending

# Preview fixes (dry-run: writes a unified diff, changes nothing)
mendapi fix --from-report impact.json

# Create a fix branch + commit + PR-ready description (local only;
# --push is required to actually push, and is never implied)
mendapi pr --repo /path/to/your/repo --from-report impact.json
```

Running from a checkout? `node app/cli.js <command>` works identically.

## What a fix looks like

This is real output — the exact diff our test suite pins, byte for byte, for the `openai-node` v3 → v4 migration pack. Note the two lines that *mention* the legacy calls inside a string and a template literal: the codemod leaves both untouched, because rules anchor on call positions in the syntax tree, not on text patterns.

```diff
--- a/lib/ai.js
+++ b/lib/ai.js
@@ -1,28 +1,27 @@
 // Demo service using the legacy openai-node v3 SDK (pre-v4 breaking change).
 // Docs note: openai.createChatCompletion({...}) was the v3 entry point.
-const { Configuration, OpenAIApi } = require('openai');
+const OpenAI = require('openai');
 
 // This string mentions the legacy call and must never be rewritten by the fixer:
 const LEGACY_HINT = 'if you still call openai.createChatCompletion( upgrade to v4';
 const AUDIT_LOG_LINE = `migrating away from .createEmbedding( for tenant`;
 
-const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
-const openai = new OpenAIApi(configuration);
+const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 
 async function summarize(text) {
-  const response = await openai.createChatCompletion({
+  const response = await openai.chat.completions.create({
     model: 'gpt-4',
     messages: [{ role: 'user', content: `Summarize: ${text}` }],
   });
-  return response.data.choices[0].message.content;
+  return response.choices[0].message.content;
 }
 
 async function embed(text) {
-  const response = await openai.createEmbedding({
+  const response = await openai.embeddings.create({
     model: 'text-embedding-ada-002',
     input: text,
   });
-  return response.data.data[0].embedding;
+  return response.data[0].embedding;
 }
 
 module.exports = { summarize, embed };
```

Every migration pack ships with a pinned diff like this one; the build fails if a pack's output drifts from its gold evidence. Six more, embedded with the same byte-match guarantee, are on the provider guides: [OpenAI](https://mendapi.com/guides/openai-node-v3-to-v4-migration.html), [AWS](https://mendapi.com/guides/aws-sdk-v2-to-v3-migration.html), [Cloudflare](https://mendapi.com/guides/cloudflare-typescript-v6-to-v7-migration.html), [PayPal](https://mendapi.com/guides/paypal-server-sdk-migration.html), [Vercel](https://mendapi.com/guides/vercel-sdk-migration.html), [Stripe](https://mendapi.com/guides/stripe-payment-records-migration.html), [Shopify](https://mendapi.com/guides/shopify-graphql-api-migration.html).

## Use it from your AI coding agent (MCP)

`mendapi mcp` starts a Model Context Protocol server on stdio — **offline-first, zero network**: every tool call runs the local CLIs against the local SQLite database only, and the server ships with zero npm dependencies. It speaks the current MCP revision (2026-07-28, per-request `_meta` version negotiation + `server/discover`) and keeps full backward compatibility with older clients that use the `initialize` handshake (2025-06-18 / 2025-03-26) — a dual-era server, because a tool that repairs breaking changes should not ship one.

Claude Code (one line):

```bash
claude mcp add mendapi -- npx mendapi mcp
```

Cursor (or any JSON-configured MCP client) — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mendapi": { "command": "npx", "args": ["mendapi", "mcp"] }
  }
}
```

Tools exposed: `scan`, `deps`, `fix`, `changes` — the same `schema_version`-stamped JSON as the CLI `--json` flags. See the [For AI agents](https://mendapi.com/docs/agents.html) docs page for the full tool catalog and an autonomous-maintenance recipe.

## Why precision matters

Alert fatigue kills tools like this. Our scanner gates every finding through:

- **Source-aware evidence rules** — an SDK release only affects repos that import that SDK; a changelog entry about an API endpoint affects anyone calling that host.
- **Sub-API filtering** for monorepo providers (Google, AWS) — a `youtube` release does not page the team that only uses S3.
- **Identifier-boundary symbol matching** — `getR` never matches `getRelatedArticles`.
- **Context-aware env-var detection** — `process.env.STRIPE_KEY` counts; a regex constant named `META_RE` does not.

Dogfooding across three production repos: the current pipeline reports **zero false positives** where an earlier naive version produced 27.

## Measured in public

We benchmark the change database against real provider spec corpora and publish the full accounting — every headline number is recomputed from archived evidence by the site's build gates, so the reports cannot drift from the data:

- [What 47 Stripe API versions taught us about breaking-change detection](https://mendapi.com/blog/stripe-parity-47-pair-capstone.html) — 47 consecutive spec pairs, head-to-head with oasdiff, zero unexplained gaps.
- [Three more providers, 49 spec pairs, zero unexplained gaps](https://mendapi.com/blog/tvp-parity-49-pair-capstone.html) — the same audit across Twilio, PayPal, and Vercel.
- [20 Twilio spec pairs: 358 findings from one engine, 142 from ours, and every disagreement named](https://mendapi.com/blog/twilio-parity-20-pair-capstone.html) — why two engines disagree by 2.5x, with every divergence accounted for.
- [11 Vercel spec pairs: a real 12-endpoint removal, and the release notes that cried breaking](https://mendapi.com/blog/vercel-parity-11-pair-capstone.html) — the changelog got it wrong in both directions; the wire did not.
- [136 raw removals, 17 real ones: what a spec diff over-reports](https://mendapi.com/blog/cloudflare-curation-136-to-17.html) — the curation rules that keep alert fatigue out of the feed.
- [821 OpenAI spec changes, 3 that can break a client: the honest negative](https://mendapi.com/blog/openai-corridor-821-to-3-capstone.html) — the value of a tool that tells you when you are fine.

## Status

Published on npm as [`mendapi`](https://www.npmjs.com/package/mendapi) (v0.5.2). Early release — the change database and migration pack registry grow daily; interfaces may still shift before 1.0.

## License

AGPL-3.0-only for the CLI (see [LICENSE](./LICENSE)). Chosen so security teams can audit every line that reads code or builds a payload, and so hosted forks must share their changes.
