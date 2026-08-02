#!/usr/bin/env node
// mendapi reclassify — applies LLM-reviewed classifications to the changes table.
// Zero npm dependencies: node:sqlite.
// Input: a JSON file of [{ id, change_type, rationale }].
// The LLM (agent) produces the JSON by reading raw excerpts; this script is the
// deterministic apply/verify layer. Only rows currently marked by a weaker
// classifier are updated, and every update is audited via the classifier column.
//
// Usage: node reclassify.js <classifications.json> [--dry-run]

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'sentinel.db');

const VALID_TYPES = new Set(['breaking', 'deprecation', 'additive', 'docs-only', 'fix', 'unknown']);

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!file) {
  console.error('Usage: node reclassify.js <classifications.json> [--dry-run]');
  process.exit(1);
}

const items = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(items) || items.length === 0) {
  console.error('Input must be a non-empty JSON array.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);

// Ensure audit column exists.
const cols = db.prepare(`PRAGMA table_info(changes)`).all().map((c) => c.name);
if (!cols.includes('class_rationale')) {
  db.exec(`ALTER TABLE changes ADD COLUMN class_rationale TEXT`);
}

const get = db.prepare('SELECT id, change_type, classifier, title FROM changes WHERE id = ?');
const upd = db.prepare(
  `UPDATE changes SET change_type = ?, classifier = 'llm-v1', class_rationale = ? WHERE id = ?`
);

let updated = 0, skipped = 0, invalid = 0;
for (const it of items) {
  if (!it || !Number.isInteger(it.id) || !VALID_TYPES.has(it.change_type) || !it.rationale) {
    console.error(`invalid item: ${JSON.stringify(it)}`);
    invalid++;
    continue;
  }
  const row = get.get(it.id);
  if (!row) { console.error(`skip id=${it.id}: not found`); skipped++; continue; }
  if (row.classifier === 'llm-v1') { console.log(`skip id=${it.id}: already llm-v1`); skipped++; continue; }
  if (!dryRun) upd.run(it.change_type, it.rationale, it.id);
  console.log(`${dryRun ? 'would set' : 'set'} id=${it.id} ${row.change_type} -> ${it.change_type} (${row.title.slice(0, 60)})`);
  updated++;
}

const byType = db.prepare('SELECT change_type, COUNT(*) c FROM changes GROUP BY change_type ORDER BY c DESC').all();
console.log(`\nupdated=${updated} skipped=${skipped} invalid=${invalid} dryRun=${dryRun}`);
console.log('by type: ' + byType.map((r) => `${r.change_type}=${r.c}`).join(' '));
db.close();
if (invalid > 0) process.exit(1);
