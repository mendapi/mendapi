#!/usr/bin/env node
// mendapi specingest — load OpenAPI spec-diff records into the changes DB.
//
// Bridges the Change Intelligence endgame (specdiff.js) into the same pipeline
// the watcher feeds: every spec-diff record becomes a `changes` row that the
// scanner, coverage report, and fixer already understand.
//
// Zero npm dependencies: node:sqlite + node:crypto + node:fs. Zero network —
// reads local files only (fetching specs is the caller's job).
//
// Row mapping:
//   provider        --provider (required)
//   source_repo     'spec-diff:<label>'   (scanner keys source_type off this)
//   title           '<kind>: <anchor> <detail>'
//   change_type     breaking -> 'breaking', otherwise 'additive'
//   classifier      'spec-diff-v1'        (deterministic, auditable)
//   effective_date  --date (optional ISO date, e.g. new-spec release date)
//   source_url      'specdiff://<provider>/<label>#<sha1(kind|anchor|detail)>'
//                   deterministic + content-addressed => re-runs are idempotent
//                   (UNIQUE constraint, INSERT OR IGNORE)
//   raw_excerpt     JSON of the record (anchor/detail feed symbol extraction)
//
// Usage:
//   node app/specingest.js --provider <p> --label <l> <old-spec.json> <new-spec.json> [opts]
//   node app/specingest.js --provider <p> --label <l> --from-json <specdiff-out.json> [opts]
// Options:
//   --db <path>     target SQLite DB (default: app/data/sentinel.db)
//   --date <ISO>    effective date to record (default: none)
//   --dry-run       print what would be inserted, write nothing
// Exit codes: 0 = ok (possibly 0 new rows), 1 = usage/parse error.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSpecs } from './specdiff.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = join(APP_DIR, 'data', 'sentinel.db');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--from-json') args.fromJson = argv[++i];
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.error('Usage: node app/specingest.js --provider <p> --label <l> (<old-spec> <new-spec> | --from-json <diff.json>) [--db <path>] [--date <ISO>] [--dry-run]');
  process.exit(1);
}

function recordId(rec) {
  return createHash('sha1').update(`${rec.kind}|${rec.anchor}|${rec.detail || ''}`).digest('hex');
}

function toRow(rec, provider, label, date) {
  const title = `${rec.kind}: ${rec.anchor}${rec.detail ? ` ${rec.detail}` : ''}`.slice(0, 300);
  return {
    provider,
    source_repo: `spec-diff:${label}`,
    title,
    change_type: rec.breaking ? 'breaking' : 'additive',
    classifier: 'spec-diff-v1',
    effective_date: date || null,
    source_url: `specdiff://${provider}/${label}#${recordId(rec)}`,
    raw_excerpt: JSON.stringify({ kind: rec.kind, anchor: rec.anchor, detail: rec.detail || '', breaking: !!rec.breaking }),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.provider || !args.label) usage();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(args.provider)) {
    console.error(`Invalid provider name: ${args.provider}`);
    process.exit(1);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`Invalid --date (expected YYYY-MM-DD): ${args.date}`);
    process.exit(1);
  }

  let records;
  try {
    if (args.fromJson) {
      const parsed = JSON.parse(readFileSync(args.fromJson, 'utf8'));
      records = Array.isArray(parsed) ? parsed : parsed.records;
      if (!Array.isArray(records)) throw new Error('no records[] array found');
    } else if (args._.length === 2) {
      const oldSpec = JSON.parse(readFileSync(args._[0], 'utf8'));
      const newSpec = JSON.parse(readFileSync(args._[1], 'utf8'));
      records = diffSpecs(oldSpec, newSpec);
    } else {
      usage();
      return;
    }
  } catch (e) {
    console.error(`Failed to load diff records: ${e.message}`);
    process.exit(1);
  }

  const valid = records.filter((r) => r && typeof r.kind === 'string' && typeof r.anchor === 'string');
  const skippedInvalid = records.length - valid.length;
  const rows = valid.map((r) => toRow(r, args.provider, args.label, args.date));

  if (args.dryRun) {
    for (const row of rows) {
      console.log(`  [${row.change_type}] ${row.title}`);
    }
    console.log(`\ndry-run: ${rows.length} rows would be ingested (invalid skipped: ${skippedInvalid})`);
    return;
  }

  const db = new DatabaseSync(args.db || DEFAULT_DB);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO changes (provider, source_repo, title, change_type, classifier, effective_date, source_url, raw_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const row of rows) {
    const r = insert.run(row.provider, row.source_repo, row.title, row.change_type, row.classifier, row.effective_date, row.source_url, row.raw_excerpt);
    inserted += r.changes;
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE source_repo = ?`).get(`spec-diff:${args.label}`).n;
  db.close();
  console.log(`inserted=${inserted} duplicates=${rows.length - inserted} invalid=${skippedInvalid} label_total=${total}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
