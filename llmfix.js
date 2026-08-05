#!/usr/bin/env node
// mendapi llmfix — BYO-compute draft fix generator for long-tail changes.
// Zero npm dependencies. This command is the fixer-side counterpart of
// `review --llm`: it turns the curated llm-fixes knowledge assets
// (app/llm-fixes/<change_id>.json) into per-repo DRAFT patches using YOUR
// configured LLM provider (see app/llmprovider.js; set MENDAPI_LLM_*).
//
// Security model (D3):
//   - Explicit opt-in only: without MENDAPI_LLM_PROVIDER this fails loudly.
//   - The transport module (app/llmtransport.js) is loaded dynamically inside
//     main() only; this file contains no network primitives itself.
//   - The repo is NEVER modified. Output is a reviewable unified-diff draft
//     per change under --out-dir, plus a drafts-report.json. Draft grade is
//     explicit: unlike deterministic migration packs, these patches are
//     LLM-generated and must be human-reviewed before applying.
//   - Fail conservative: any unparseable / invalid / non-compiling LLM output
//     is dropped with a logged reason; nothing is guessed.
//
// Usage:
//   node app/llmfix.js --from-report <impact.json> [--repo path]
//                      [--max N] [--out-dir dir] [--list]
//
//   --list  print the candidate changes (those with a code-fixable knowledge
//           asset and no deterministic pack) without calling the LLM.
//
// Pipeline position: scan -> review [--llm] -> fix (packs) -> llmfix (drafts).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LLM_FIXES_DIR = join(ROOT, 'llm-fixes');
const MAX_FILE_BYTES = 64 * 1024; // keep prompts bounded
const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);

function usage() {
  console.error('Usage: mendapi llmfix --from-report <impact.json> [--repo <path>] [--max N] [--out-dir <dir>] [--list]');
  console.error('Requires MENDAPI_LLM_* config (BYO compute; see the BYO LLM docs at https://mendapi.com/docs/byo-llm.html). Emits DRAFT patches only; never modifies the repo.');
  process.exit(2);
}

// Flag-only parser. Positional arguments are a usage error, NOT something to
// silently drop: `mendapi deps ./some/repo` is the most natural thing a user
// types, and dropping the path made `--repo` fall back to process.cwd() —
// scanning the WRONG tree while reporting success (Loop 665: a 1-file fixture
// path silently became a 1016-file scan of the cwd, 8s of CPU, wrong answer,
// exit 0). Every path/value on these subcommands is passed via an explicit
// flag, so anything not starting with `--` can only be a mistake. Fail loud.
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; continue; }
    console.error(`Unexpected argument: ${a}`);
    console.error('This command takes flags only (for example: --repo <path>). Run with --help for usage.');
    process.exit(2);
  }
  return args;
}

// Load the curated knowledge asset for a change id, if any.
function loadAsset(changeId) {
  const p = join(LLM_FIXES_DIR, `${changeId}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Changes already covered by a deterministic migration pack are not llmfix
// material (the pack is strictly better).
async function packCoveredIds() {
  const { MIGRATIONS } = await import('./fixer.js');
  const covered = new Set();
  for (const m of Object.values(MIGRATIONS)) for (const id of m.covers || []) covered.add(id);
  return covered;
}

function buildCandidates(report, covered, repoPath) {
  const seen = new Set();
  const out = [];
  for (const im of report.impacts || []) {
    const id = im.change?.id;
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    if (covered.has(id)) continue;
    const asset = loadAsset(id);
    if (!asset || asset.verdict !== 'code-fixable') continue;
    // Collect distinct affected files that exist and are prompt-sized.
    const files = [];
    for (const s of im.usage_sites || []) {
      if (!s.file || files.includes(s.file)) continue;
      const abs = isAbsolute(s.file) ? s.file : join(repoPath, s.file);
      try {
        const content = readFileSync(abs, 'utf8');
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
        files.push(s.file);
      } catch { /* unreadable -> skip file */ }
      if (files.length >= 3) break;
    }
    if (files.length === 0) continue;
    out.push({ change: im.change, asset, files, usage_sites: im.usage_sites || [] });
  }
  return out;
}

function syntaxOk(file, content) {
  const ext = file.slice(file.lastIndexOf('.'));
  if (!JS_EXTS.has(ext)) return true; // only JS dialects are checkable with node
  const r = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], { input: content, encoding: 'utf8' });
  if (r.status === 0) return true;
  const r2 = spawnSync(process.execPath, ['--check', '-'], { input: content, encoding: 'utf8' });
  return r2.status === 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['from-report']) usage();

  let report;
  try { report = JSON.parse(readFileSync(args['from-report'], 'utf8')); }
  catch (e) { console.error(`Cannot read impact report: ${e.message}`); process.exit(2); }
  if (!Array.isArray(report.impacts)) { console.error('Not an impact report: missing impacts[]'); process.exit(2); }
  const repoPath = args.repo || report.repo;
  if (!repoPath) { console.error('Impact report has no repo path; pass --repo explicitly.'); process.exit(2); }

  const covered = await packCoveredIds();
  const max = args.max ? parseInt(args.max, 10) : Infinity;
  const candidates = buildCandidates(report, covered, repoPath).slice(0, max);

  if (args.list) {
    for (const c of candidates) {
      console.log(`${c.change.id}\t${c.change.provider}\t${c.asset.fix?.strategy || '-'}\t${c.files.join(',')}`);
    }
    console.log(`candidates=${candidates.length}`);
    process.exit(0);
  }

  // BYO opt-in gate: resolve config BEFORE any work; fails loudly when unset.
  const { resolveConfig, LlmConfigError } = await import('./llmprovider.js');
  const { complete } = await import('./llmtransport.js'); // sole egress module, loaded only here
  let config;
  try {
    config = resolveConfig();
  } catch (e) {
    if (e instanceof LlmConfigError) { console.error(e.message); process.exit(1); }
    throw e;
  }

  if (candidates.length === 0) {
    console.log('No draft-fix candidates in this report (no code-fixable knowledge asset without a deterministic pack).');
    process.exit(0);
  }

  // Default under cwd/.mendapi — see fixer.js for the rationale (no writes
  // next to the installed package, dot-dir invisible to scans).
  const outDir = args['out-dir'] || join(process.cwd(), '.mendapi', 'llm-fix-drafts');
  mkdirSync(outDir, { recursive: true });
  const { unifiedDiff } = await import('./fixer.js');

  const SYSTEM = [
    'You are generating a minimal code fix for an upstream API breaking change.',
    'You get the official migration guidance and the full content of one affected file.',
    'Return STRICT JSON: {"updated_content": "<the complete updated file>", "notes": "one sentence"}.',
    'Rules: change ONLY what the migration requires; preserve formatting, comments and unrelated code byte-for-byte;',
    'if no safe mechanical change applies to this file, return {"updated_content": null, "notes": "why"}.',
  ].join(' ');

  const drafts = [];
  let generated = 0, skipped = 0, failed = 0;
  console.error(`Drafting fixes for ${candidates.length} change(s) with ${config.provider} (${config.model})...`);

  for (const c of candidates) {
    const fileDiffs = [];
    for (const rel of c.files) {
      const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
      const before = readFileSync(abs, 'utf8');
      const prompt = JSON.stringify({
        change: { id: c.change.id, provider: c.change.provider, title: c.change.title },
        migration_guide: c.asset.fix?.migration_guide || null,
        example_before: c.asset.fix?.example_before || null,
        example_after: c.asset.fix?.example_after || null,
        file: rel,
        file_content: before,
      }, null, 2);
      let raw;
      try {
        raw = await complete(config, { system: SYSTEM, prompt, maxTokens: 8192 });
      } catch (e) {
        console.error(`change=${c.change.id} file=${rel}: LLM call failed (${e.message}) — skipped`);
        failed++;
        continue;
      }
      let parsed = null;
      try { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { /* fall through */ }
      if (!parsed || !('updated_content' in parsed)) {
        console.error(`change=${c.change.id} file=${rel}: unparseable LLM response — skipped`);
        failed++;
        continue;
      }
      if (parsed.updated_content == null) {
        console.error(`change=${c.change.id} file=${rel}: model declined (${String(parsed.notes || '').slice(0, 120)})`);
        skipped++;
        continue;
      }
      const after = String(parsed.updated_content);
      if (after === before) { skipped++; continue; }
      if (!syntaxOk(rel, after)) {
        console.error(`change=${c.change.id} file=${rel}: updated content fails syntax check — dropped (fail conservative)`);
        failed++;
        continue;
      }
      fileDiffs.push({ file: rel, patch: unifiedDiff(rel, before, after), notes: String(parsed.notes || '').slice(0, 300) });
    }
    if (fileDiffs.length === 0) continue;
    const patchPath = join(outDir, `llm-draft-${c.change.id}.patch`);
    writeFileSync(patchPath, fileDiffs.map((d) => d.patch).join(''));
    drafts.push({
      change_id: c.change.id,
      provider: c.change.provider,
      strategy: c.asset.fix?.strategy || null,
      asset_confidence: c.asset.confidence || null,
      grade: 'llm-draft',
      generator: `llm-byo-v1:${config.provider}`,
      files: fileDiffs.map((d) => ({ file: d.file, notes: d.notes })),
      patch: `llm-draft-${c.change.id}.patch`,
    });
    generated++;
    console.log(`draft change=${c.change.id} files=${fileDiffs.length} -> ${patchPath}`);
  }

  const reportOut = {
    tool: 'mendapi-llmfix-v1',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo: repoPath,
    source_report: resolve(args['from-report']),
    provider: config.provider,
    model: config.model,
    grade: 'llm-draft (human review required before apply)',
    drafts,
  };
  const reportPath = join(outDir, 'drafts-report.json');
  writeFileSync(reportPath, JSON.stringify(reportOut, null, 2) + '\n');
  console.log(`\nReport: ${reportPath}`);
  console.log(`generated=${generated} skipped=${skipped} failed=${failed}`);
  if (generated === 0 && failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}

// referenced for test tooling
export { buildCandidates, loadAsset };
