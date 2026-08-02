#!/usr/bin/env node
// mendapi mcp — Model Context Protocol server over stdio (JSON-RPC 2.0,
// newline-delimited messages). Zero npm dependencies, zero network code:
// every tool call runs the local mendapi CLIs / SQLite database only.
//
// Tools exposed:
//   scan    — scan a repo for usage impacted by upstream API breaking changes
//   deps    — inventory which provider API surfaces a repo uses (optionally --match)
//   fix     — preview (dry-run) or apply a deterministic migration pack
//   revalidate — audit migration packs for staleness against the local DB
//   changes — query the local change database (provider / type filters)
//
// Usage: mendapi mcp    (then speak MCP over stdin/stdout)
//
// Protocol notes (dual-era server, per MCP spec revision 2026-07-28):
//   - Modern clients (2026-07-28+) send per-request metadata: every request
//     carries _meta["io.modelcontextprotocol/protocolVersion"]. No handshake.
//     server/discover advertises supported versions, capabilities and identity.
//     Results carry resultType:"complete"; list results carry ttlMs/cacheScope.
//     Unsupported versions get UnsupportedProtocolVersionError (-32022).
//   - Legacy clients (2025-06-18 / 2025-03-26) still get the initialize
//     handshake + ping; that path is kept intact (we are the "do not break
//     your downstream" product — we do not break ours).
//   - unknown methods with an id get a -32601 error; notifications are ignored
//   - tool results follow the MCP content shape: { content: [{type:'text', text}], isError? }

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'sentinel.db');

// Server identity: version is read from package.json (single source) so the
// MCP serverInfo can never drift from the published npm version again.
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const SERVER_INFO = { name: 'mendapi', version: PKG_VERSION };
// Dual-era version support (MCP spec revision 2026-07-28, "Versioning and
// Compatibility"): modern versions are served statelessly via per-request
// _meta; legacy versions are served via the initialize handshake.
const MODERN_VERSIONS = ['2026-07-28'];
const LEGACY_VERSIONS = ['2025-06-18', '2025-03-26'];
const PROTOCOL_VERSION = '2025-06-18'; // legacy default echoed by initialize
const META = 'io.modelcontextprotocol/';
// Freshness hints for CacheableResult (tools/list): the tool registry only
// changes when the binary changes, so a long public TTL is honest.
const LIST_TTL_MS = 3600000;

// ---------- tool registry ----------

const TOOLS = [
  {
    name: 'scan',
    description:
      'Scan a repository for code impacted by monitored upstream API breaking changes. ' +
      'Runs fully locally (no network). Returns the mendapi scan report JSON (schema_version 1): ' +
      'impacts[] with change metadata, confidence (high/medium/low), and file:line usage sites.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Absolute or relative path to the repository to scan' },
        provider: { type: 'string', description: 'Optional: restrict to a single provider (e.g. "stripe")' },
        include_prereleases: { type: 'boolean', description: 'Optional: include pre-release changes (default false)' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'deps',
    description:
      'Inventory which provider API surfaces a repository uses (imports, endpoints, env credentials, ' +
      'SDK call chains), with file:line evidence. Local only. Set match=true to join the inventory ' +
      'against monitored breaking changes and migration packs. Returns JSON (schema_version 1).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to the repository to inventory' },
        match: { type: 'boolean', description: 'Also match surfaces against monitored changes and fix packs (default false)' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'fix',
    description:
      'Preview (default, dry-run) or apply a deterministic migration pack against a repository. ' +
      'Dry-run writes nothing to the repo; it produces a unified diff patch and a fix report JSON ' +
      '(schema_version 1). Set apply=true only after reviewing the dry-run diff.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Path to the repository to fix' },
        migration: { type: 'string', description: 'Migration pack name (see `mendapi fix` for the registry)' },
        apply: { type: 'boolean', description: 'Actually rewrite files (default false = dry-run preview)' },
        run_checks: { type: 'boolean', description: 'With apply=true, also run the repo\'s own test/typecheck scripts after the rewrite and report them in verification.repo_checks (default false; without apply it reports status=skipped with the reason)' },
        ack_stale: { type: 'boolean', description: 'Acknowledge a needs-revalidation pack and run it anyway (default false). Only set after auditing the pack with the revalidate tool — a stale pack otherwise refuses to run (fix exit 3)' },
        out_dir: { type: 'string', description: 'Optional: directory for the patch + report artifacts' },
      },
      required: ['repo', 'migration'],
    },
  },
  {
    name: 'revalidate',
    description:
      'Audit every migration pack for staleness against the local change database (read-only, local only). ' +
      'Returns the revalidate report JSON: per-pack status (fresh | needs-revalidation | no-covers | covers-missing), ' +
      'API-surface anchor set, and any newer upstream changes on the same surface. ' +
      'A needs-revalidation pack will refuse to apply (fix exit 3) until re-verified.',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string', description: 'Optional: path to an alternate change database' },
      },
    },
  },
  {
    name: 'changes',
    description:
      'Query the local API change database (read-only). Filter by provider and/or change type ' +
      '(breaking | deprecation | additive | docs-only | unknown). Returns the newest records first.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional: provider name filter (e.g. "stripe")' },
        change_type: { type: 'string', description: 'Optional: change type filter (e.g. "breaking")' },
        limit: { type: 'number', description: 'Max records to return (default 20, max 200)' },
      },
    },
  },
];

// ---------- tool implementations ----------

function runCli(script, args) {
  // Child CLIs print their JSON report on stdout. Non-zero exits are part of
  // the CLI contract (e.g. fixer exit 1 = no changes), so capture stdout either way.
  try {
    return execFileSync(process.execPath, [join(ROOT, script), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.stdout && String(e.stdout).trim()) return String(e.stdout);
    throw new Error(String(e.stderr || e.message).trim().slice(0, 2000));
  }
}

function toolScan(args) {
  if (!args.repo) throw new Error('scan: "repo" is required');
  const repo = resolve(String(args.repo));
  if (!existsSync(repo)) throw new Error(`scan: repo not found: ${repo}`);
  const cliArgs = ['--repo', repo, '--json', '--quiet'];
  if (args.provider) cliArgs.push('--provider', String(args.provider));
  if (args.include_prereleases) cliArgs.push('--include-prereleases');
  return runCli('scanner.js', cliArgs);
}

function toolDeps(args) {
  if (!args.repo) throw new Error('deps: "repo" is required');
  const repo = resolve(String(args.repo));
  if (!existsSync(repo)) throw new Error(`deps: repo not found: ${repo}`);
  const cliArgs = ['--repo', repo, '--json'];
  if (args.match) cliArgs.push('--match');
  return runCli('deps.js', cliArgs);
}

function toolFix(args) {
  if (!args.repo) throw new Error('fix: "repo" is required');
  if (!args.migration) throw new Error('fix: "migration" is required');
  const repo = resolve(String(args.repo));
  if (!existsSync(repo)) throw new Error(`fix: repo not found: ${repo}`);
  const cliArgs = ['--repo', repo, '--migration', String(args.migration), '--json'];
  if (args.apply) cliArgs.push('--apply');
  if (args.run_checks) cliArgs.push('--run-checks');
  if (args.ack_stale) cliArgs.push('--ack-stale');
  if (args.out_dir) cliArgs.push('--out-dir', resolve(String(args.out_dir)));
  return runCli('fixer.js', cliArgs);
}

function toolRevalidate(args) {
  // Exit 1 (stale packs found) is part of the CLI contract; runCli already
  // returns the stdout report either way.
  const cliArgs = ['--json'];
  if (args.db) cliArgs.push('--db', resolve(String(args.db)));
  return runCli('revalidate.js', cliArgs);
}

async function toolChanges(args) {
  if (!existsSync(DB_PATH)) throw new Error('changes: no change database found — run `mendapi sync` first');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const conds = [];
    const params = [];
    if (args.provider) { conds.push('provider = ?'); params.push(String(args.provider)); }
    if (args.change_type) { conds.push('change_type = ?'); params.push(String(args.change_type)); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
    const rows = db.prepare(
      `SELECT id, provider, title, change_type, effective_date, fixability, source_url
         FROM changes ${where} ORDER BY id DESC LIMIT ?`
    ).all(...params, limit);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM changes ${where}`).get(...params).n;
    return JSON.stringify({
      tool: 'mendapi-mcp-changes/0.1',
      schema_version: 1,
      total_matching: total,
      returned: rows.length,
      changes: rows,
    }, null, 2);
  } finally {
    db.close();
  }
}

const TOOL_IMPL = { scan: toolScan, deps: toolDeps, fix: toolFix, revalidate: toolRevalidate, changes: toolChanges };

// ---------- JSON-RPC plumbing ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  // ----- era detection (per-request; dual-era server, spec 2026-07-28) -----
  // A request carrying _meta["io.modelcontextprotocol/protocolVersion"] is
  // modern and is served statelessly. Requests without it (or `initialize`)
  // are served under legacy semantics.
  const meta = params && params._meta ? params._meta : undefined;
  const requestedVersion = meta ? meta[META + 'protocolVersion'] : undefined;
  const isModern = requestedVersion !== undefined && method !== 'initialize';

  if (isModern && !MODERN_VERSIONS.includes(requestedVersion)) {
    // UnsupportedProtocolVersionError: MUST list supported versions.
    if (isRequest) {
      return send({
        jsonrpc: '2.0', id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: MODERN_VERSIONS.concat(LEGACY_VERSIONS), requested: requestedVersion },
        },
      });
    }
    return;
  }

  // Modern results carry a required resultType field and the server SHOULD
  // identify itself in each result's _meta.
  const modernReply = (rid, result) => reply(rid, {
    resultType: 'complete',
    ...result,
    _meta: { ...(result._meta || {}), [META + 'serverInfo']: SERVER_INFO },
  });
  const respond = isModern ? modernReply : reply;

  switch (method) {
    case 'initialize':
      // Legacy handshake path (2025-06-18 / 2025-03-26 clients). Kept intact:
      // modern-only servers strand legacy clients with no fall-forward path.
      return reply(id, {
        protocolVersion: LEGACY_VERSIONS.includes(params && params.protocolVersion)
          ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no response
    case 'ping':
      return respond(id, {});
    case 'server/discover':
      // Mandatory RPC in 2026-07-28: advertise supported versions, capabilities
      // and identity. Also serves as the stdio backward-compat probe for
      // dual-era clients. Answered even without modern _meta so probing
      // clients always get a deterministic DiscoverResult.
      return reply(id, {
        resultType: 'complete',
        supportedVersions: MODERN_VERSIONS.concat(LEGACY_VERSIONS),
        capabilities: { tools: {} },
        instructions:
          'mendapi detects upstream API breaking changes and repairs affected code. ' +
          'All tools run locally against the bundled change database; no network calls are made. ' +
          'Typical flow: `deps` to inventory provider API surfaces, `scan` to find impacted code, ' +
          '`changes` to inspect the change records, `revalidate` to audit pack freshness, ' +
          '`fix` to preview (dry-run) or apply a migration pack.',
        ttlMs: LIST_TTL_MS,
        cacheScope: 'public',
        _meta: { [META + 'serverInfo']: SERVER_INFO },
      });
    case 'tools/list':
      // CacheableResult fields (ttlMs/cacheScope) are required on list results
      // in 2026-07-28; harmless extras for legacy clients.
      return respond(id, { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: 'public' });
    case 'tools/call': {
      const name = params && params.name;
      const impl = TOOL_IMPL[name];
      if (!impl) {
        return respond(id, {
          content: [{ type: 'text', text: `Unknown tool: ${name}. Available: ${Object.keys(TOOL_IMPL).join(', ')}` }],
          isError: true,
        });
      }
      try {
        const text = await impl((params && params.arguments) || {});
        return respond(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return respond(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (isRequest) return replyError(id, -32601, `Method not found: ${method}`);
      return; // unknown notification: ignore
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return replyError(null, -32700, 'Parse error');
    }
    // Serialize handling so responses come out in request order.
    queue = queue.then(() => handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32603, `Internal error: ${e.message}`);
      }
    });
  });
  rl.on('close', () => {
    // Do NOT process.exit() here: large tool responses may still be buffered
    // in the stdout pipe, and process.exit() truncates pending writes.
    // Let the event loop drain naturally once the queue settles.
    queue.then(() => { process.exitCode = 0; });
  });
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: mendapi mcp');
  console.log('');
  console.log('Starts a Model Context Protocol server on stdio (JSON-RPC 2.0, newline-delimited).');
  console.log('Tools: scan, deps, fix, revalidate, changes. All local; no network code.');
  process.exit(0);
}

main();
