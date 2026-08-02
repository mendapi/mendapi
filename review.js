#!/usr/bin/env node
// mendapi review — LLM confidence review layer for impact reports.
// Zero npm dependencies, zero network calls (D3: no default egress).
//
// Deterministic apply/verify layer: the LLM (agent) reads pending impacts and
// produces a verdicts JSON; this script validates and applies them, producing a
// reviewed report with a full audit trail. Mirrors app/reclassify.js design.
//
// Modes:
//   node app/review.js <impact.json> --pending
//     Emit the impacts that need semantic review (confidence=medium) as a
//     compact JSON work list for the LLM (change title/excerpt + usage evidence).
//
//   node app/review.js <impact.json> --verdicts <verdicts.json> [--out reviewed.json]
//     Apply verdicts. Each verdict: { change_id, verdict, rationale }
//       verdict = "confirm"  -> impact is real; promote confidence medium -> high
//       verdict = "unlikely" -> repo does not touch the changed surface; demote -> low
//       verdict = "keep"     -> evidence inconclusive; stays medium
//     Only medium-confidence impacts are reviewable (high = deterministic symbol
//     match, low = insufficient evidence by construction; both stay untouched).
//     Every reviewed impact gets a `review` audit block; unreviewed ones are
//     untouched. Report gains `review_summary` and tool version suffix.
//
//   node app/review.js <impact.json> --llm [--out reviewed.json] [--dry-run] [--max N]
//     BYO-compute mode: generate verdicts with YOUR configured LLM provider
//     (see app/llmprovider.js; set MENDAPI_LLM_PROVIDER etc.). This is the ONLY
//     path in review that performs network I/O, it is explicitly opt-in, and
//     the traffic goes to the endpoint YOU configured — mendapi ships no
//     vendor, no key, no default egress. The transport module
//     (app/llmtransport.js) is loaded dynamically only inside this branch.
//     Impacts whose LLM response cannot be parsed are left untouched (fail
//     conservative, never guess).

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
import { DB_PATH } from './dbpath.js';

const VERDICTS = new Map([
  ['confirm', 'high'],
  ['unlikely', 'low'],
  ['keep', 'medium'],
]);

function usage() {
  console.error('Usage: mendapi review <impact.json> --pending');
  console.error('       mendapi review <impact.json> --verdicts <verdicts.json> [--out reviewed.json] [--dry-run]');
  console.error('       mendapi review <impact.json> --llm [--out reviewed.json] [--dry-run] [--max N]  (BYO LLM; requires MENDAPI_LLM_* config)');
  process.exit(1);
}

const argv = process.argv.slice(2);
const reportPath = argv[0];
if (!reportPath || reportPath.startsWith('--')) usage();
const pendingMode = argv.includes('--pending');
const llmMode = argv.includes('--llm');
const dryRun = argv.includes('--dry-run');
const vIdx = argv.indexOf('--verdicts');
const verdictsPath = vIdx >= 0 ? argv[vIdx + 1] : null;
const oIdx = argv.indexOf('--out');
const outPath = oIdx >= 0 ? argv[oIdx + 1] : null;
const mIdx = argv.indexOf('--max');
const maxItems = mIdx >= 0 ? parseInt(argv[mIdx + 1], 10) : Infinity;
if (!pendingMode && !verdictsPath && !llmMode) usage();

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (!Array.isArray(report.impacts)) {
  console.error('Not an impact report: missing impacts[]');
  process.exit(1);
}

// ---------- pending list builder (shared by --pending and --llm) ----------
function buildPending() {
  // Pull raw excerpts from the DB so the LLM sees the full change text,
  // not just the title (read-only).
  let db = null;
  try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch { /* DB optional */ }
  const getExcerpt = db ? db.prepare('SELECT raw_excerpt, migration_hint FROM changes WHERE id = ?') : null;

  const pending = report.impacts
    .filter((im) => im.confidence === 'medium' && !im.review)
    .map((im) => {
      const row = getExcerpt ? getExcerpt.get(im.change.id) : null;
      return {
        change_id: im.change.id,
        provider: im.change.provider,
        title: im.change.title,
        change_type: im.change.type,
        source_type: im.change.source_type || null,
        raw_excerpt: row?.raw_excerpt ? String(row.raw_excerpt).slice(0, 1500) : null,
        migration_hint: row?.migration_hint || null,
        usage_kinds: im.usage_kinds || [],
        usage_evidence: (im.usage_sites || []).slice(0, 5).map((s) => ({
          file: s.file, line: s.line, kind: s.kind, detail: s.detail, snippet: s.snippet,
        })),
      };
    });
  if (db) db.close();
  return pending;
}

// ---------- pending mode ----------
if (pendingMode) {
  const pending = buildPending();
  console.log(JSON.stringify({ tool: 'mendapi-review/0.1', schema_version: 1, report: reportPath, pending_count: pending.length, pending }, null, 2));
  process.exit(0);
}

// ---------- llm mode (BYO compute; the only network path, explicitly opt-in) ----------
async function llmVerdicts() {
  // Dynamic imports: llmtransport (the sole egress module) is loaded only here.
  const { resolveConfig } = await import('./llmprovider.js');
  const { complete } = await import('./llmtransport.js');
  const config = resolveConfig(); // fails loudly if the user has not opted in

  const pending = buildPending().slice(0, maxItems);
  if (pending.length === 0) {
    console.log('No medium-confidence impacts pending review.');
    process.exit(0);
  }
  console.error(`Reviewing ${pending.length} impact(s) with ${config.provider} (${config.model})...`);

  const SYSTEM = [
    'You review whether an upstream API change actually impacts a codebase.',
    'Given the change description and code usage evidence, answer with strict JSON:',
    '{"verdict":"confirm|unlikely|keep","rationale":"one sentence"}',
    'confirm = the code clearly touches the changed API surface.',
    'unlikely = the evidence shows the code does not touch the changed surface.',
    'keep = the evidence is inconclusive. When unsure, answer keep.',
  ].join(' ');

  const verdictsOut = [];
  for (const p of pending) {
    const prompt = JSON.stringify(p, null, 2);
    let raw;
    try {
      raw = await complete(config, { system: SYSTEM, prompt, maxTokens: 300 });
    } catch (e) {
      console.error(`change_id=${p.change_id}: LLM call failed (${e.message}) — leaving untouched`);
      continue;
    }
    let parsed = null;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch { /* fall through */ }
    if (!parsed || !VERDICTS.has(parsed.verdict) || !parsed.rationale) {
      console.error(`change_id=${p.change_id}: unparseable LLM response — leaving untouched`);
      continue;
    }
    verdictsOut.push({ change_id: p.change_id, verdict: parsed.verdict, rationale: String(parsed.rationale).slice(0, 500) });
  }
  return verdictsOut;
}

// ---------- apply mode ----------
const verdicts = llmMode
  ? await llmVerdicts()
  : JSON.parse(readFileSync(verdictsPath, 'utf8'));
const reviewerTag = llmMode ? `llm-byo-v1:${process.env.MENDAPI_LLM_PROVIDER || 'unknown'}` : 'llm-v1';
if (!Array.isArray(verdicts) || verdicts.length === 0) {
  if (llmMode) {
    console.error('LLM produced no usable verdicts; report left untouched.');
    process.exit(1);
  }
  console.error('Verdicts must be a non-empty JSON array.');
  process.exit(1);
}

const byChangeId = new Map();
for (const im of report.impacts) byChangeId.set(im.change.id, im);

let applied = 0, skipped = 0, invalid = 0;
for (const v of verdicts) {
  if (!v || !Number.isInteger(v.change_id) || !VERDICTS.has(v.verdict) || !v.rationale) {
    console.error(`invalid verdict: ${JSON.stringify(v)}`);
    invalid++;
    continue;
  }
  const im = byChangeId.get(v.change_id);
  if (!im) { console.error(`skip change_id=${v.change_id}: not in report`); skipped++; continue; }
  if (im.confidence !== 'medium') { console.error(`skip change_id=${v.change_id}: confidence=${im.confidence} not reviewable`); skipped++; continue; }
  if (im.review) { console.log(`skip change_id=${v.change_id}: already reviewed`); skipped++; continue; }
  const newConfidence = VERDICTS.get(v.verdict);
  console.log(`${dryRun ? 'would set' : 'set'} change_id=${v.change_id} medium -> ${newConfidence} (${v.verdict}) ${im.change.title.slice(0, 60)}`);
  if (!dryRun) {
    im.review = { reviewer: reviewerTag, verdict: v.verdict, rationale: v.rationale };
    im.confidence = newConfidence;
  }
  applied++;
}

if (!dryRun) {
  // Re-sort: severity first, confidence second (same ordering contract as scanner).
  const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
  const confRank = { high: 0, medium: 1, low: 2 };
  report.impacts.sort((a, b) =>
    (sevRank[a.change.severity] ?? 9) - (sevRank[b.change.severity] ?? 9) ||
    (confRank[a.confidence] ?? 9) - (confRank[b.confidence] ?? 9));
  const dist = {};
  for (const im of report.impacts) dist[im.confidence] = (dist[im.confidence] || 0) + 1;
  report.review_summary = {
    reviewer: reviewerTag,
    reviewed_at: new Date().toISOString(),
    verdicts_applied: applied,
    confidence_distribution: dist,
  };
  const dest = outPath || reportPath;
  writeFileSync(dest, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nwrote ${dest}`);
}
console.log(`applied=${applied} skipped=${skipped} invalid=${invalid} dryRun=${dryRun}`);
if (invalid > 0) process.exit(1);
