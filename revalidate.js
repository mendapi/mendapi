#!/usr/bin/env node
// mendapi revalidate — migration pack staleness audit.
// Zero npm dependencies, zero network (reads only the local change DB).
//
// A migration pack encodes an assumption about the upstream API surface at the
// moment its covered changes were recorded. When the watcher later ingests a
// NEW breaking/deprecation change on the same API surface, that assumption may
// no longer hold: the pack could rewrite code toward a state the upstream has
// already moved past. This tool detects exactly that condition and flags the
// pack `needs-revalidation`. Stale packs must never be applied silently — the
// fixer refuses to run a flagged pack unless the operator explicitly
// acknowledges it after re-verifying the rules (see fixer --ack-stale).
//
// Matching semantics (conservative, explainable):
//   baseline   = max(fetched_at) across the pack's covered change records —
//                the moment the pack's upstream snapshot was taken.
//   candidate  = any breaking/deprecation change on the same provider fetched
//                AFTER the baseline.
//   same surface:
//     - same normalized source stream (source_repo with spec-diff version
//       pair suffix stripped), AND
//     - if BOTH the covered change and the candidate carry an endpoint anchor
//       (METHOD /path in title/source_url), the paths must overlap; if either
//       side has no anchor, the stream-level match stands (SDK-release
//       changes have no path anchor — a new breaking release on the same SDK
//       is enough to warrant a re-check).
//
// Usage:
//   node app/revalidate.js [--json] [--db <path>]
// Exit codes: 0 = all packs fresh, 1 = at least one pack needs revalidation.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorPath } from './deps.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(ROOT, 'data', 'sentinel.db');

// spec-diff source repos carry the version pair in the name
// (e.g. "spec-diff:twilio-verify-1.30.0-to-1.40.0"); strip it so successive
// replays of the same spec stream compare as the same surface stream.
export function normalizeStream(sourceRepo) {
  const s = String(sourceRepo || '');
  return s.replace(/-v?\d[\w.]*-to-v?\d[\w.]*$/, '');
}

function changeAnchor(ch) {
  return anchorPath(ch.title) || anchorPath(ch.source_url);
}

// Full "METHOD /path" surface anchor (the semantic identity of the API
// surface a change touches). anchorPath() keeps only the path because
// overlap matching is path-based; the method is still part of the surface
// identity we report, so capture it separately here.
export function anchorSurface(sourceUrlOrTitle) {
  const m = String(sourceUrlOrTitle || '').match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s:)]+)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function changeSurface(ch) {
  return anchorSurface(ch.title) || anchorSurface(ch.source_url);
}

function pathsOverlap(a_, b_) {
  const a = a_.split('/').filter(Boolean);
  const b = b_.split('/').filter(Boolean);
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    if (x === y || /^\{[^}]+\}$/.test(x) || /^\{[^}]+\}$/.test(y)) continue;
    return false;
  }
  return n >= 2 || n === Math.max(a.length, b.length);
}

// Upstream chronology: prefer effective_date (when the change was actually
// published upstream) over fetched_at (mere ingestion order — backfilled
// history can ingest OLDER releases a second after newer ones).
function chronoKey(ch) {
  return ch.effective_date || String(ch.fetched_at || '').slice(0, 10);
}

// Assess every pack in `migrations` against the change DB at `dbPath`.
// Returns { generated_at, db, packs: [{ pack, provider, status, baseline,
//   covers, surfaces: ['METHOD /path', ...],
//   newer_changes: [{id, title, fetched_at, anchor}] }] }.
// status: fresh | needs-revalidation | no-covers | covers-missing
export function assessPacks(migrations, dbPath = DEFAULT_DB_PATH) {
  if (!existsSync(dbPath)) {
    return { error: `no change database at ${dbPath} — run \`mendapi sync\` first` };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const all = db.prepare(
    "SELECT id, provider, source_repo, title, change_type, source_url, effective_date, fetched_at FROM changes WHERE change_type IN ('breaking','deprecation')"
  ).all();
  db.close();
  const byId = new Map(all.map((c) => [c.id, c]));

  const packs = [];
  for (const [name, mig] of Object.entries(migrations)) {
    const covers = mig.covers || [];
    if (!covers.length) {
      packs.push({ pack: name, provider: mig.provider, status: 'no-covers', covers: [] });
      continue;
    }
    const covered = covers.map((id) => byId.get(id)).filter(Boolean);
    if (!covered.length) {
      packs.push({ pack: name, provider: mig.provider, status: 'covers-missing', covers });
      continue;
    }
    const baseline = covered.map(chronoKey).sort().pop();
    const streams = new Set(covered.map((c) => normalizeStream(c.source_repo)));
    const coveredAnchors = covered.map(changeAnchor).filter(Boolean);
    // API-surface anchor set: the pack's fix target expressed as upstream
    // API semantics (METHOD /path), not as text patterns. Derived from the
    // covered change records so it always reflects the recorded evidence.
    const coveredSurfaces = [...new Set(covered.map(changeSurface).filter(Boolean))].sort();

    const newer = [];
    for (const ch of all) {
      if (ch.provider !== mig.provider) continue;
      if (covers.includes(ch.id)) continue;
      if (!(chronoKey(ch) > baseline)) continue;
      if (!streams.has(normalizeStream(ch.source_repo))) continue;
      // Pre-releases don't move the stable API surface the pack targets.
      if (/[-.](alpha|beta|rc)[-.]?\d*\b/i.test(ch.title)) continue;
      // Human re-verification stamp: a pack may declare `revalidatedThrough`
      // (ISO date) after its rules were manually re-checked against upstream.
      // Changes published on or before that date are acknowledged; anything
      // newer re-triggers the flag.
      if (mig.revalidatedThrough && chronoKey(ch) <= mig.revalidatedThrough) continue;
      const anchor = changeAnchor(ch);
      const firehose = String(ch.source_repo || '').startsWith('changelog:');
      if (firehose) {
        // Vendor changelog feeds mix every product into one stream — a
        // stream-level match proves nothing. Require an explicit endpoint
        // anchor overlap; anchorless firehose entries are skipped.
        if (!anchor || !coveredAnchors.length) continue;
        if (!coveredAnchors.some((ca) => pathsOverlap(ca, anchor))) continue;
      } else if (anchor && coveredAnchors.length) {
        // Single-surface streams (SDK releases, spec-diff): if both sides
        // carry anchors, require overlap; otherwise the stream match stands.
        if (!coveredAnchors.some((ca) => pathsOverlap(ca, anchor))) continue;
      }
      newer.push({ id: ch.id, title: ch.title.slice(0, 120), published: chronoKey(ch), anchor: anchor || null });
    }
    const entry = {
      pack: name,
      provider: mig.provider,
      status: newer.length ? 'needs-revalidation' : 'fresh',
      baseline,
      covers,
      surfaces: coveredSurfaces,
      newer_changes: newer,
    };
    if (newer.length) {
      // Re-verification closure hint: after the operator re-checks the pack
      // rules against the current upstream, stamping `revalidatedThrough`
      // with this exact date (the newest flagged change's publish date)
      // acknowledges every listed change and flips the pack back to fresh.
      // Any earlier date leaves the flag raised; any later date would
      // silently acknowledge changes the operator never saw listed.
      entry.suggested_revalidated_through = newer.map((n) => n.published).sort().pop();
    }
    packs.push(entry);
  }
  return { generated_at: new Date().toISOString(), db: dbPath, packs };
}

// Single-pack check used by the fixer before applying a migration.
// Returns null when the pack is safe to apply (fresh / no-covers / DB absent),
// or the pack assessment object when it needs revalidation.
export function checkPackFreshness(packName, migrations, dbPath = DEFAULT_DB_PATH) {
  if (!existsSync(dbPath)) return null; // offline use: no DB, no staleness signal
  const res = assessPacks({ [packName]: migrations[packName] }, dbPath);
  if (res.error) return null;
  const p = res.packs[0];
  return p && p.status === 'needs-revalidation' ? p : null;
}

async function main() {
  const { MIGRATIONS } = await import('./fixer.js');
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx !== -1 ? args[dbIdx + 1] : DEFAULT_DB_PATH;
  if (args.includes('--help')) {
    console.error('Usage: mendapi revalidate [--json] [--db <path>]');
    process.exit(2);
  }
  const res = assessPacks(MIGRATIONS, dbPath);
  if (res.error) { console.error(res.error); process.exit(2); }
  const stale = res.packs.filter((p) => p.status === 'needs-revalidation');
  if (json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log('');
    console.log('mendapi revalidate — migration pack staleness audit');
    console.log(`packs: ${res.packs.length}  fresh: ${res.packs.filter((p) => p.status === 'fresh').length}  needs-revalidation: ${stale.length}  no-covers: ${res.packs.filter((p) => p.status === 'no-covers').length}`);
    console.log('');
    for (const p of res.packs) {
      if (p.status !== 'needs-revalidation') continue;
      console.log(`[STALE] ${p.pack} (${p.provider}) — baseline ${p.baseline}`);
      if (p.surfaces && p.surfaces.length) {
        console.log(`   surfaces: ${p.surfaces.slice(0, 4).join(', ')}${p.surfaces.length > 4 ? ` (+${p.surfaces.length - 4} more)` : ''}`);
      }
      for (const n of p.newer_changes) {
        console.log(`   newer change #${n.id} (${n.published})${n.anchor ? ` ${n.anchor}` : ''}: ${n.title}`);
      }
      console.log('   -> re-verify the pack rules against the current upstream surface, then update covers/rules.');
      if (p.suggested_revalidated_through) {
        console.log(`   -> once re-verified, stamp revalidatedThrough: '${p.suggested_revalidated_through}' on the pack to acknowledge the listed changes.`);
      }
      console.log('');
    }
    if (!stale.length) console.log('All covering packs are fresh against the current change database.');
  }
  // Do not call process.exit() here: with piped stdout, exit() truncates
  // pending writes at 64KiB. Setting exitCode lets Node flush fully.
  process.exitCode = stale.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
