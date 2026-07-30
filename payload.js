#!/usr/bin/env node
// payload.js — Upload payload builder for hosted reporting (schema + sanitizer).
//
// Security model (D3): code never leaves the machine. If a user explicitly
// opts into hosted reporting (--report-to, NOT implemented here), the only
// thing that may ever be transmitted is the metadata payload built by this
// module. Design principles:
//
//   1. WHITELIST construction — the payload is built field-by-field from an
//      explicit allowlist. Unknown fields are dropped, so new local-only
//      fields added to the impact report can never leak by accident.
//   2. NO SNIPPETS — `snippet` fields (raw source lines) exist only in the
//      local report and are structurally impossible to include here.
//   3. SECRETS REDACTION — every string that enters the payload is passed
//      through redactSecrets() as defense-in-depth (API keys, tokens,
//      high-entropy literals).
//   4. NO NETWORK — this module builds and validates payloads only. It
//      performs no I/O beyond stdin/stdout/fs for the CLI self-test.
//
// CLI:
//   node app/payload.js --self-test            run built-in unit tests
//   node app/payload.js <impact-report.json>   print sanitized payload

'use strict';

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PAYLOAD_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema (documentation + machine-checkable shape)
// ---------------------------------------------------------------------------

const PAYLOAD_SCHEMA = {
  version: 'number — payload schema version',
  tool: 'string — scanner name/version',
  generated_at: 'string — ISO timestamp from the local report',
  repo_name: 'string — basename of the scanned repo (full local path is never sent)',
  files_scanned: 'number',
  providers_detected: 'array<string>',
  changes_considered: 'number',
  sub_api_filtered: 'number',
  impacts_found: 'number',
  impacts: [
    {
      change: {
        id: 'number — change id in the public changes DB',
        provider: 'string',
        title: 'string — from the provider public release feed',
        type: 'string — breaking|deprecation|additive|fix|docs-only|unknown',
        severity: 'string',
        effective_date: 'string',
        source_url: 'string — public provider URL',
      },
      confidence: 'string — high|medium|low',
      usage_kinds: 'array<string> — import|env-var|api-host',
      symbols_extracted: 'number',
      matched_symbols: 'array<string> — public API symbol names from the changelog',
      symbol_sites: [{ file: 'string', line: 'number', symbol: 'string' }], // NO snippet
      usage_sites: [{ kind: 'string', detail: 'string', file: 'string', line: 'number' }], // NO snippet
    },
  ],
};

// ---------------------------------------------------------------------------
// Secrets redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style secret keys
  /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe secret keys
  /\brk_(live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe restricted keys
  /\bwhsec_[A-Za-z0-9]{16,}\b/g, // Stripe webhook secrets
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, // SendGrid API keys
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{16,}\b/g, // bearer tokens
  /(?<=(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)['"]?\s*[:=]\s*['"]?)[^'"\s]{8,}/gi, // key=value assignments
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex (sha-like tokens, private keys in hex)
];

function redactSecrets(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// ---------------------------------------------------------------------------
// Whitelist builders
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' ? redactSecrets(v) : '';
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function strArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(redactSecrets) : [];
}

function buildChange(c) {
  c = c || {};
  return {
    id: num(c.id),
    provider: str(c.provider),
    title: str(c.title),
    type: str(c.type),
    severity: str(c.severity),
    effective_date: str(c.effective_date),
    source_url: str(c.source_url),
  };
}

function buildSymbolSite(s) {
  s = s || {};
  // NOTE: `snippet` is intentionally NOT copied — raw source never leaves.
  return { file: str(s.file), line: num(s.line), symbol: str(s.symbol) };
}

function buildUsageSite(s) {
  s = s || {};
  // NOTE: `snippet` is intentionally NOT copied — raw source never leaves.
  return { kind: str(s.kind), detail: str(s.detail), file: str(s.file), line: num(s.line) };
}

function buildImpact(i) {
  i = i || {};
  return {
    change: buildChange(i.change),
    confidence: str(i.confidence),
    usage_kinds: strArr(i.usage_kinds),
    symbols_extracted: num(i.symbols_extracted),
    matched_symbols: strArr(i.matched_symbols),
    symbol_sites: (Array.isArray(i.symbol_sites) ? i.symbol_sites : []).map(buildSymbolSite),
    usage_sites: (Array.isArray(i.usage_sites) ? i.usage_sites : []).map(buildUsageSite),
  };
}

function repoBasename(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * Build the metadata-only upload payload from a local impact report.
 * Whitelist construction: anything not listed here is dropped.
 */
function buildUploadPayload(report) {
  if (!report || typeof report !== 'object') throw new Error('report must be an object');
  return {
    version: PAYLOAD_SCHEMA_VERSION,
    tool: str(report.tool),
    generated_at: str(report.generated_at),
    repo_name: redactSecrets(repoBasename(report.repo)),
    files_scanned: num(report.files_scanned),
    providers_detected: strArr(report.providers_detected),
    changes_considered: num(report.changes_considered),
    sub_api_filtered: num(report.sub_api_filtered),
    impacts_found: num(report.impacts_found),
    impacts: (Array.isArray(report.impacts) ? report.impacts : []).map(buildImpact),
  };
}

// ---------------------------------------------------------------------------
// Validation gate — run before any (future) transmission
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(['snippet', 'source', 'code', 'raw_excerpt', 'migration_hint']);

/**
 * Deep-validate a payload: no forbidden keys anywhere, no unredacted secrets
 * in any string value. Throws on violation. Returns true when clean.
 */
function assertPayloadSafe(payload) {
  const stack = [[payload, '$']];
  while (stack.length) {
    const [node, path] = stack.pop();
    if (Array.isArray(node)) {
      node.forEach((v, idx) => stack.push([v, `${path}[${idx}]`]));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`forbidden key "${k}" at ${path}.${k}`);
        stack.push([v, `${path}.${k}`]);
      }
    } else if (typeof node === 'string') {
      const redacted = redactSecrets(node);
      if (redacted !== node) throw new Error(`unredacted secret-like string at ${path}`);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const results = [];
  const t = (name, fn) => {
    try {
      fn();
      results.push(`PASS: ${name}`);
    } catch (e) {
      results.push(`FAIL: ${name} — ${e.message}`);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const fixture = {
    tool: 'mendapi-scanner/0.4',
    generated_at: '2026-07-25T00:00:00Z',
    repo: '/opt/builds/acme-billing',
    files_scanned: 1039,
    providers_detected: ['stripe'],
    changes_considered: 10,
    sub_api_filtered: 0,
    impacts_found: 1,
    local_only_debug: { secret: 'sk_live_abcdefghijklmnop' }, // unknown field, must be dropped
    impacts: [
      {
        change: {
          id: 134,
          provider: 'stripe',
          title: 'v22.3.1',
          type: 'breaking',
          severity: 'high',
          effective_date: '2026-07-01',
          source_url: 'https://github.com/stripe/stripe-node/releases/tag/v22.3.1',
        },
        confidence: 'high',
        usage_kinds: ['import'],
        symbols_extracted: 12,
        matched_symbols: ['HttpClient'],
        symbol_sites: [
          {
            file: 'lib/billing.js',
            line: 3,
            symbol: 'HttpClient',
            snippet: "const stripe = require('stripe')('sk_live_51NxyzREALKEY000');",
          },
        ],
        usage_sites: [
          {
            provider: 'stripe',
            kind: 'env-var',
            detail: 'STRIPE_',
            file: '.env.example',
            line: 1,
            snippet: 'STRIPE_SECRET_KEY=sk_test_abcdefghij123456',
          },
        ],
      },
    ],
  };

  const payload = buildUploadPayload(fixture);
  const json = JSON.stringify(payload);

  t('no snippet key anywhere in payload', () => {
    assert(!/"snippet"/.test(json), 'snippet key leaked');
  });
  t('no raw source content in payload', () => {
    assert(!json.includes('require('), 'source line leaked');
    assert(!json.includes('STRIPE_SECRET_KEY='), 'dotenv line leaked');
  });
  t('no secret values in payload', () => {
    assert(!json.includes('sk_live_'), 'live key leaked');
    assert(!json.includes('sk_test_'), 'test key leaked');
  });
  t('unknown top-level fields are dropped (whitelist)', () => {
    assert(!('local_only_debug' in payload), 'unknown field leaked');
  });
  t('full local repo path is not sent, basename only', () => {
    assert(payload.repo_name === 'acme-billing', `got ${payload.repo_name}`);
    assert(!json.includes('/opt/'), 'local path leaked');
    assert(!json.includes('/home/'), 'local path leaked');
  });
  t('metadata fields survive intact', () => {
    assert(payload.impacts[0].change.id === 134, 'change id lost');
    assert(payload.impacts[0].matched_symbols[0] === 'HttpClient', 'symbol lost');
    assert(payload.impacts[0].symbol_sites[0].file === 'lib/billing.js', 'file lost');
    assert(payload.impacts[0].usage_sites[0].line === 1, 'line lost');
  });
  t('redactSecrets covers common token formats', () => {
    const samples = [
      'sk-proj-abcdefghijklmnopqrstuvwx',
      'sk_live_abcdefghij1234567890',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'xoxb-1234567890-abcdefghijk',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz1234567',
      'api_key = "supersecretvalue123"',
    ];
    for (const s of samples) {
      assert(redactSecrets(s).includes('[REDACTED]'), `not redacted: ${s}`);
    }
  });
  t('assertPayloadSafe passes on clean payload', () => {
    assert(assertPayloadSafe(payload) === true, 'clean payload rejected');
  });
  t('assertPayloadSafe rejects snippet smuggled in', () => {
    const dirty = JSON.parse(json);
    dirty.impacts[0].symbol_sites[0].snippet = 'const x = 1;';
    let threw = false;
    try {
      assertPayloadSafe(dirty);
    } catch (e) {
      threw = true;
    }
    assert(threw, 'snippet not caught');
  });
  t('assertPayloadSafe rejects unredacted secret smuggled in', () => {
    const dirty = JSON.parse(json);
    dirty.tool = 'scanner sk_live_abcdefghij1234567890';
    let threw = false;
    try {
      assertPayloadSafe(dirty);
    } catch (e) {
      threw = true;
    }
    assert(threw, 'secret not caught');
  });

  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  for (const r of results) console.log(r);
  console.log(`SELF-TEST RESULT: PASS=${results.length - failed} FAIL=${failed}`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv[2];
  if (arg === '--self-test') {
    process.exit(selfTest() ? 0 : 1);
  } else if (arg && arg !== '--help') {
    const report = JSON.parse(readFileSync(arg, 'utf8'));
    const payload = buildUploadPayload(report);
    assertPayloadSafe(payload);
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('Usage: node app/payload.js --self-test | <impact-report.json>');
    process.exit(arg === '--help' ? 0 : 1);
  }
}

export {
  PAYLOAD_SCHEMA_VERSION,
  PAYLOAD_SCHEMA,
  buildUploadPayload,
  assertPayloadSafe,
  redactSecrets,
};
