#!/usr/bin/env node
// mendapi fixability — applies LLM-reviewed fixability verdicts to the changes table.
// Zero npm dependencies: node:sqlite. Zero network.
//
// Fixability answers one question per breaking/deprecation change: could a code
// migration (rule pack or LLM-assisted codemod) mend this change in a consumer
// repo? This keeps the 90% north-star coverage denominator honest:
//   - code-fixable:     a code migration can mend it (counts in denominator)
//   - unclear:          undocumented surface; cannot rule fixability out
//                       (conservatively counts in denominator — no gaming)
//   - not-code-fixable: runtime upgrades, docs moves, platform policy, infra,
//                       pre-release preview churn, purely additive changes
//                       (excluded from the honest denominator)
//
// The LLM (agent) produces the verdict JSON by reading raw excerpts; this
// script is the deterministic apply/verify layer, mirroring reclassify.js.
// Every write is audited (fixability_reason + fixability_classifier columns).
//
// Usage: node app/fixability.js <verdicts.json> [--dry-run] [--reaudit]
//        verdicts.json: [{ id, fixability, reason }]
//        --reaudit: allow upgrading rows already audited by llm-v1 (deep
//        re-audit against original specs); rows are re-tagged llm-fix-v1 and
//        become idempotent under that tag.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'sentinel.db');

const VALID = new Set(['code-fixable', 'not-code-fixable', 'unclear']);

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const reaudit = process.argv.includes('--reaudit');
if (!file) {
  console.error('Usage: node app/fixability.js <verdicts.json> [--dry-run]');
  process.exit(1);
}

const items = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(items) || items.length === 0) {
  console.error('Input must be a non-empty JSON array.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);

// Ensure audit columns exist.
const cols = db.prepare('PRAGMA table_info(changes)').all().map((c) => c.name);
if (!cols.includes('fixability')) db.exec('ALTER TABLE changes ADD COLUMN fixability TEXT');
if (!cols.includes('fixability_reason')) db.exec('ALTER TABLE changes ADD COLUMN fixability_reason TEXT');
if (!cols.includes('fixability_classifier')) db.exec('ALTER TABLE changes ADD COLUMN fixability_classifier TEXT');

const get = db.prepare('SELECT id, change_type, fixability, fixability_classifier, title FROM changes WHERE id = ?');
const upd = db.prepare(
  'UPDATE changes SET fixability = ?, fixability_reason = ?, fixability_classifier = ? WHERE id = ?',
);
const writeTag = reaudit ? 'llm-fix-v1' : 'llm-v1';

let updated = 0, skipped = 0, invalid = 0;
for (const it of items) {
  if (!it || !Number.isInteger(it.id) || !VALID.has(it.fixability) || !it.reason) {
    console.error(`invalid item: ${JSON.stringify(it)}`);
    invalid++;
    continue;
  }
  const row = get.get(it.id);
  if (!row) { console.error(`skip id=${it.id}: not found`); skipped++; continue; }
  if (row.fixability_classifier === 'llm-fix-v1') { console.log(`skip id=${it.id}: already llm-fix-v1`); skipped++; continue; }
  if (!reaudit && row.fixability_classifier === 'llm-v1') { console.log(`skip id=${it.id}: already llm-v1`); skipped++; continue; }
  if (!dryRun) upd.run(it.fixability, it.reason, writeTag, it.id);
  console.log(`${dryRun ? 'would set' : 'set'} id=${it.id} fixability=${it.fixability} (${row.title.slice(0, 60)})`);
  updated++;
}

const byFix = db.prepare(
  "SELECT COALESCE(fixability,'(unset)') f, COUNT(*) c FROM changes WHERE change_type IN ('breaking','deprecation') GROUP BY f ORDER BY c DESC",
).all();
console.log(`\nupdated=${updated} skipped=${skipped} invalid=${invalid} dryRun=${dryRun}`);
console.log('breaking+deprecation by fixability: ' + byFix.map((r) => `${r.f}=${r.c}`).join(' '));
db.close();
if (invalid > 0) process.exit(1);
