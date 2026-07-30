#!/usr/bin/env node
// mendapi pr — turns a fixer migration into a reviewable git branch,
// commit, and PR-ready description. Zero npm dependencies: node:child_process
// drives git; the fixer is invoked in-process via CLI.
//
// Usage:
//   node app/pr.js --repo /path/to/git/repo --migration openai-v3-to-v4 [--out-dir dir] [--run-checks] [--push]
//   node app/pr.js --repo /path/to/git/repo --from-report /path/to/impact.json [--out-dir dir] [--run-checks] [--push]
//
// Flow:
//   1. Verify the repo is a clean git worktree.
//   2. Create branch mendapi/<migration>.
//   3. Run the fixer with --apply on that branch.
//   4. Commit the changes with a descriptive message.
//   5. Write pr-body.md (title + body ready for `gh pr create`).
//   6. With --push (and a configured remote + gh CLI), push the branch and
//      open the PR. Without --push everything stays local — safe default.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function git(repo, ...cmd) {
  return execFileSync('git', ['-C', repo, ...cmd], { encoding: 'utf8' }).trim();
}

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv);
  const repo = args.repo;
  if (!repo) fail('Usage: node pr.js --repo <git-repo> (--migration <name> | --from-report <impact.json>) [--out-dir <dir>] [--push]');
  if (!existsSync(join(repo, '.git'))) fail(`Not a git repository: ${repo}`);

  // 1. Clean worktree required — a fix PR must not mix in unrelated edits.
  const status = git(repo, 'status', '--porcelain');
  if (status) fail(`Worktree is dirty; commit or stash first:\n${status}`);

  // Resolve migration name (direct or via impact report).
  let migration = args.migration;
  let reportRef = null;
  if (!migration && args['from-report']) {
    const impact = JSON.parse(readFileSync(args['from-report'], 'utf8'));
    reportRef = args['from-report'];
    // Delegate provider->migration matching to the fixer by running it in
    // from-report dry-run first would duplicate work; instead reuse its map
    // via a probe call. Simpler: fixer prints applicable migrations; but for
    // determinism we re-derive from the report using the fixer's own CLI.
    const probe = execFileSync('node', [join(ROOT, 'fixer.js'), '--from-report', reportRef, '--repo', repo, '--out-dir', '/tmp/mendapi-probe'], { encoding: 'utf8' });
    const m = probe.match(/^Applicable migrations: (.+)$/m);
    if (!m || m[1].trim() === '(none)') fail('No applicable migrations for this impact report.', 1);
    migration = m[1].split(',')[0].trim(); // one migration per PR keeps review focused
  }
  if (!migration) fail('Provide --migration or --from-report.');

  const outDir = args['out-dir'] || join(ROOT, '..', 'loop', 'evidence', `pr-${migration}`);
  mkdirSync(outDir, { recursive: true });

  const baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const branch = `mendapi/${migration}`;

  // 2. Create (or reset) the fix branch.
  git(repo, 'checkout', '-B', branch);

  // 3. Apply the migration. With --run-checks the fixer also runs the repo's
  // own test/typecheck scripts after apply and records the verdicts in
  // verification.repo_checks — the PR body then cites those real numbers.
  const fixerArgs = [join(ROOT, 'fixer.js'), '--repo', repo, '--migration', migration, '--apply', '--out-dir', outDir];
  if (args['run-checks']) fixerArgs.push('--run-checks');
  let fixOut;
  try {
    fixOut = execFileSync('node', fixerArgs, { encoding: 'utf8' });
  } catch (e) {
    git(repo, 'checkout', baseBranch);
    fail(`Fixer reported no changes or failed:\n${e.stdout || e.message}`, 1);
  }

  // 4. Commit.
  const changed = git(repo, 'status', '--porcelain');
  if (!changed) {
    git(repo, 'checkout', baseBranch);
    fail('Fixer ran but produced no changes; nothing to commit.', 1);
  }
  const report = JSON.parse(readFileSync(join(outDir, 'fix-report.json'), 'utf8'));
  const title = `fix: migrate to new ${report.provider} API (${migration})`;
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', title, '-m', `Automated by mendapi.\n\nMigration: ${report.title}\nReference: ${report.reference}`);
  const sha = git(repo, 'rev-parse', '--short', 'HEAD');

  // 5. PR body.
  const fileList = report.files.map((f) => `- \`${f.file}\` — ${f.rules_applied.length} rule(s): ${f.rules_applied.join('; ')}`).join('\n');
  const sc = report.verification && report.verification.syntax_check;
  const verificationLine = sc
    ? `Every rewritten file was syntax-checked with \`${sc.tool}\`: ${sc.passed} passed${sc.skipped ? `, ${sc.skipped} skipped (non-JS extensions \`node --check\` cannot parse)` : ''}${sc.failed ? `, ${sc.failed} FAILED — review before merging` : ''}. Per-file verdicts are in the attached fix report.`
    : 'The full patch is attached in the fix report.';
  const rc = report.verification && report.verification.repo_checks;
  const repoChecksLine = rc && rc.status === 'ran'
    ? ` After applying the patch, the repo's own check scripts were run: ${rc.checks.map((c) => `\`npm run ${c.script}\` ${c.status === 'pass' ? 'passed' : `FAILED (exit ${c.exit_code})`}`).join(', ')}${rc.failed > 0 ? ' — review before merging' : ' — the repo tests are still green after this change'}.`
    : '';
  const body = `## What

Automated migration for an upstream API breaking change.

- **Migration:** ${report.title}
- **Provider:** ${report.provider}
- **Reference:** ${report.reference}
${reportRef ? `- **Triggered by impact report:** \`${reportRef}\`\n` : ''}
## Files changed

${fileList}

## How to review

Each change is a deterministic rule-pack transform derived from the official migration guide. ${verificationLine}${repoChecksLine}

---
*Opened by [mendapi](https://github.com/mendapi) — Dependabot, but for every API you depend on.*
`;
  writeFileSync(join(outDir, 'pr-body.md'), `# ${title}\n\n${body}`);
  writeFileSync(join(outDir, 'pr-meta.json'), JSON.stringify({
    title, branch, base: baseBranch, commit: sha, migration,
    repo, pushed: false, generated_at: new Date().toISOString(),
  }, null, 2));

  console.log(`Branch: ${branch} (base: ${baseBranch})`);
  console.log(`Commit: ${sha} ${title}`);
  console.log(`PR body: ${join(outDir, 'pr-body.md')}`);

  // 6. Optional push + real PR.
  if (args.push) {
    const remotes = git(repo, 'remote');
    if (!remotes) fail('No git remote configured; cannot push.', 1);
    git(repo, 'push', '-u', 'origin', branch);
    const prOut = execFileSync('gh', ['pr', 'create', '--title', title, '--body', body, '--base', baseBranch, '--head', branch], { cwd: repo, encoding: 'utf8' });
    console.log(prOut.trim());
  } else {
    console.log('Local only (pass --push to push and open a real PR).');
  }

  // Return to base branch so repeated runs stay clean.
  git(repo, 'checkout', baseBranch);
}

main();
