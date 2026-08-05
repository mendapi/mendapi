# Changelog

All notable changes to mendapi. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.6] - 2026-08-05

Changes landed in the repository but not yet published to npm. The set of files
that differ from the published tarball is derived mechanically — see
`loop/release-drift.mjs` and the release-drift gate.

### Fixed

- **`scan`, `fix`, `deps`, `llmfix` and `pr` no longer scan the wrong directory.**
  A positional path (`mendapi deps ./my-repo` — the most natural thing to type)
  was silently discarded, and `--repo` fell back to the current working
  directory. The command then produced a complete, well-formed, confidently
  worded report about a tree the user never asked about, and exited 0. Stray
  positional arguments are now a usage error: the offending argument is named,
  the message points at `--help`, and the process exits 2.
  Affects `deps.js`, `fixer.js`, `llmfix.js`, `pr.js`, `scanner.js`.

- **`pr` no longer commits or deletes files you own.** The commit was staged
  with `git add -A`, which swept in every artifact the clean-worktree check had
  just exempted as yours — your `impact.json` and the entire `.mendapi/`
  directory, change database included — and then removed `impact.json` from the
  working tree when it checked back out to the base branch. Staging is now
  limited to the files the fixer actually rewrote.

- **`pr` works when `node` is not on `PATH`.** The child fixer was spawned as a
  bare `node`, which crashes under an agent, a CI runner, or an npx shim with a
  different `PATH`. It now re-enters through `process.execPath`.

- **`pr` no longer collides with other users through a shared temp path.** Its
  probe run wrote to a hardcoded `/tmp/mendapi-probe` and left the directory
  behind; each run now gets a private temp directory and cleans up after itself.

- **`pr --from-report` resolves the report path against your shell's working
  directory**, not against wherever git checkouts happen to have moved the
  process mid-run. Argument errors are also reported before worktree state, so a
  mistyped filename no longer surfaces as a confusing "dirty worktree" complaint
  naming the report you asked for.

- **`fix --from-report --json` emits run-level `verification`.** The aggregate
  output omitted the block that the per-migration output carries, so anything
  consuming the documented JSON pipeline — including the CI recipe in the docs —
  hit a `TypeError` on its first run.

- **`scan`'s closing hint names a real file.** It always printed the placeholder
  `<report>`, leaving the user to guess. It now reflects actual state: with
  `--out`, it prints the real filename; without it, it tells you to add `--out`
  first.

### Changed

- **README quickstart starts with `sync`.** The first block told a new user to
  run `scan` against a change database that does not exist yet on a cold
  install, so the documented first command exited 2. The three-step path
  (`sync` → `scan --out` → `fix --from-report`) is now explicit, and the one
  command that touches the network is named as such.

## [0.5.5] - 2026-08-04

### Fixed

- `mendapi <subcommand> -h` was not normalized to `--help` before dispatch, so
  the short flag failed on every subcommand.

## [0.5.4] - 2026-08-03

### Added

- `--version` flag, read from `package.json` as the single source of truth.

### Fixed

- `sync --help` is offline-safe: it prints usage instead of triggering a network
  fetch.
- The CLI fails loudly on Node older than 22.13 (the `node:sqlite` floor)
  instead of failing obscurely later.

## [0.5.3] - 2026-08-02

### Fixed

- Default `--out-dir` is `<cwd>/.mendapi` rather than a path inside the
  development tree.
- Database path resolution is single-sourced through `dbpath.js`, so npm
  consumers persist `sentinel.db` under `<cwd>/.mendapi` instead of inside
  `node_modules`.

## [0.5.2] - 2026-08-02

### Fixed

- `astlite.js` is included in the published package. Without it, `npx mendapi
  fix` was broken in 0.5.2's initial upload.

## [0.5.1] - 2026-08-01

### Added

- `mcpName` and MCP-related keywords, for the Model Context Protocol registry.

## [0.5.0] - 2026-07-31

First public release on npm.

### Added

- `sync` — fetch the upstream API change feed into a local SQLite database. The
  only command that touches the network.
- `scan` — find upstream breaking changes that hit your code, with file, line,
  symbol and a confidence score.
- `fix` — draft the migration as a reviewable diff; nothing is written until you
  pass `--apply`.
- `review`, `deps`, `revalidate`, `llmfix`, `pr` subcommands.
- `mendapi mcp` — a zero-dependency stdio MCP server exposing the toolset to any
  MCP client.
- Agent skill for Claude Code, Cursor and other agent runtimes.
