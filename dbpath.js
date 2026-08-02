// dbpath.js — single source of truth for where the change database lives.
//
// Resolution order (read and write use the same rules, so every command
// agrees on one location):
//
//   1. MENDAPI_DB env var — explicit override, used verbatim.
//   2. <package>/data/sentinel.db — but only when it already exists.
//      This keeps the repo/dev workflow (where the DB is checked into the
//      working tree next to the source) working unchanged, and stays
//      backward compatible with consumers who synced under older versions
//      (their DB sat inside node_modules/mendapi/data).
//   3. <cwd>/.mendapi/sentinel.db — the default for npm consumers.
//
// Rationale for (3): writing into the package install directory
// (node_modules/mendapi/data) means `npm update` / a reinstall silently
// deletes the user's synced database. A dot-directory in the project the
// user runs mendapi from survives dependency churn, and `.mendapi` is
// already skipped by the scanner/fixer walkers.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));
const PKG_DB = join(PKG_ROOT, 'data', 'sentinel.db');

export function resolveDbPath() {
  if (process.env.MENDAPI_DB) return resolve(process.env.MENDAPI_DB);
  if (existsSync(PKG_DB)) return PKG_DB;
  return join(process.cwd(), '.mendapi', 'sentinel.db');
}

export const DB_PATH = resolveDbPath();
