#!/usr/bin/env node
// mendapi — Dependabot, but for every API you depend on.
// Single entry point for npx: dispatches subcommands to the component CLIs.
// Zero npm dependencies.
//
// Usage:
//   npx mendapi scan [--repo <path>] [--out <file.json>] [--json]
//   npx mendapi review <impact.json> --pending
//   npx mendapi fix --from-report <impact.json> [--apply]
//   npx mendapi pr --from-report <impact.json> [--push]
//   npx mendapi --help

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the version: package.json (never hand-write it here).
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const COMMANDS = {
  sync:   { script: 'watcher.js', summary: 'Fetch the latest API change feed from provider release channels (network)' },
  scan:   { script: 'scanner.js', summary: 'Scan a repo for usage impacted by upstream API breaking changes' },
  review: { script: 'review.js',  summary: 'Review medium-confidence findings (LLM semantic pass, deterministic apply)' },
  fix:    { script: 'fixer.js',   summary: 'Preview or apply deterministic migration fixes (dry-run by default)' },
  llmfix: { script: 'llmfix.js',  summary: 'Draft fixes for LLM-assisted changes with your own LLM (explicit opt-in, --list works offline)' },
  deps:   { script: 'deps.js',    summary: 'Inventory which provider API surfaces this repo uses (evidence-backed, local only)' },
  revalidate: { script: 'revalidate.js', summary: 'Audit migration packs for staleness against newer upstream changes (local only)' },
  pr:     { script: 'pr.js',      summary: 'Turn a fix into a reviewable git branch + PR-ready description (local by default)' },
  mcp:    { script: 'mcp.js',     summary: 'Run a Model Context Protocol server on stdio (tools: scan, fix, deps, revalidate, changes; local only)' },
};

function printHelp() {
  console.log('mendapi — Dependabot, but for every API you depend on.');
  console.log('');
  console.log('Your code never leaves your machine: scan, review, and fix run locally');
  console.log('with no network code (mechanically enforced by the test suite).');
  console.log('');
  console.log('Usage: mendapi <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${c.summary}`);
  }
  console.log('');
  console.log('Run `mendapi <command> --help` (or with no args) for command options.');
  console.log('Run `mendapi --version` to print the installed version.');
}

// Preflight: node:sqlite is only available unflagged on Node >= 22.13.0 (23.4.0 on the 23.x line).
// Older 22.x passes a naive "22+" check yet crashes with ERR_UNKNOWN_BUILTIN_MODULE — fail loud
// with a clear message instead of a stack trace. Required version is read from package.json engines.
// Called after the --help/--version branches: those need no sqlite and must always work.
function checkNodeVersion() {
  let required = '22.13.0';
  try {
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines;
    const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(engines?.node || '');
    if (m) required = m[1];
  } catch { /* fall back to the documented floor */ }
  const cur = process.versions.node.split('.').map(Number);
  const req = required.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (cur[i] > req[i]) return;
    if (cur[i] < req[i]) {
      console.error(`mendapi requires Node.js >= ${required} (built-in node:sqlite).`);
      console.error(`You are running Node.js ${process.versions.node}. Please upgrade: https://nodejs.org/`);
      process.exit(1);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printHelp();
  process.exit(cmd ? 0 : 2);
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(pkgVersion());
  process.exit(0);
}

checkNodeVersion();

const target = COMMANDS[cmd];
if (!target) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available commands: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(2);
}

// Suppress the node:sqlite ExperimentalWarning on every subcommand: it prints two lines of
// noise to stderr on each run (bad first impression, pollutes MCP stdio logs). The flag
// exists since Node 21.3.0 and our engines floor is 22.13.0, so it is always available here.
const res = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, target.script), ...rest],
  { stdio: 'inherit' }
);
process.exit(res.status ?? 1);
