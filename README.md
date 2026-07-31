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

## Status

Published on npm as [`mendapi`](https://www.npmjs.com/package/mendapi) (v0.5.0). Early release — the change database and migration pack registry grow daily; interfaces may still shift before 1.0.

## License

AGPL-3.0-only for the CLI (see [LICENSE](./LICENSE)). Chosen so security teams can audit every line that reads code or builds a payload, and so hosted forks must share their changes.
