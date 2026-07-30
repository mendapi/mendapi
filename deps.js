#!/usr/bin/env node
// mendapi deps — per-repo API dependency inventory (provider x API surface x location).
// Zero npm dependencies, zero network. Answers: "which vendors' API surfaces does
// this codebase actually touch, and where?" Every mapping carries evidence
// (file:line + snippet) so the inventory is fully explainable.
//
// Usage:
//   node app/deps.js [--repo /path/to/repo] [--json] [--out inventory.json] [--match]
//
// --match additionally joins the inventory against the local change DB and lists
// monitored breaking/deprecation changes whose endpoint anchors intersect the
// repo's endpoint surfaces (precise subscription: "will I be hit, and where?").
//
// Surface kinds:
//   module        an SDK package the repo imports (evidence: import/require line)
//   sdk-call      a concrete SDK method chain invoked on a client instance
//                 (e.g. cloudflare.kv.namespaces.values.get) — resolved through
//                 the import binding + `new Ctor(...)` instance variables only,
//                 so identical chains on unrelated local objects are never counted
//   endpoint      a concrete HTTP path used against the provider's API host
//   env           provider credential/config environment variables read
//   api-host      raw references to the provider API host (fallback evidence)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNATURES, scanRepo, walk } from './scanner.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'sentinel.db');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- endpoint surface extraction ----------
// A line only yields an endpoint surface when it references the provider's API
// host (or a template/string clearly rooted at it). Bare "/v1/foo" strings with
// no host context are ambiguous across vendors and are deliberately skipped —
// explainability beats recall (unclear > guessing).
function extractEndpoints(line, hosts) {
  const out = [];
  for (const host of hosts) {
    const re = new RegExp(`${escapeRe(host)}(/[A-Za-z0-9_./$${'{'}}\\-]*)`, 'g');
    for (const m of line.matchAll(re)) {
      let path = m[1];
      // normalize interpolation slots to a stable placeholder: JS template
      // literals (`${x}`) and Python f-string / str.format slots (`{x}`).
      // Idempotent — `{param}` itself re-normalizes to `{param}`.
      path = path.replace(/\$\{[^}]*\}/g, '{param}').replace(/\{[^}]*\}/g, '{param}').replace(/\/+$/, '');
      if (path && path !== '/') out.push(path);
    }
  }
  return out;
}

// ---------- sdk-call surface extraction ----------
// Resolve SDK method chains through the import binding, never by chain shape
// alone: an identical `.values.get(...)` chain on an unrelated local object must
// not be counted. Resolution path (per file):
//   1. find the local binding for a provider module import
//      (import X from 'mod' / import { A } from 'mod' / const X = require('mod'))
//   2. find instance variables created from that binding: `const c = new X(...)`
//      (default-export classes; named bindings are used directly too)
//   3. collect `root.seg1.seg2...method(` chains where root is a known binding
//      or instance variable — recorded as `mod:root.seg1...method` normalized
//      to the binding-agnostic form `<module> client.seg1...method`
const CHAIN_RE = /\b([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;

export function extractSdkCalls(text, moduleNames, opts = {}) {
  const isPy = !!opts.isPy;
  const isRb = !!opts.isRb;
  // Cross-module re-export roots (JS): chain roots proven in ANOTHER file and
  // imported here. Each entry is { name, mod, prefix } where the proof chain
  // is: export line in the source file (a proven root at statement level) +
  // the relative import line here — both line-anchored facts, composed as a
  // deterministic module-graph join (no scope tracking). See buildInventory.
  const externalRoots = Array.isArray(opts.externalRoots) ? opts.externalRoots : [];
  // Namespace-import roots (JS): `import * as api from './rel'` binds `api`
  // to the module namespace object whose members are exactly the exporting
  // file's proven exports. Each entry is { name, exports: [{name, mod,
  // prefix}] } — chains dispatch on their FIRST segment against that export
  // table ('default' joins the '@default' sentinel). Members not in the
  // table never bind. See buildInventory for the join construction.
  const nsRoots = Array.isArray(opts.nsRoots) ? opts.nsRoots : [];
  const isGo = !!opts.isGo;
  const isPhp = !!opts.isPhp;
  // PHP namespace roots: [{ mod, ns }] where mod is the provider's signature
  // detail (the namespace itself) already proven by a use statement or a
  // fully-qualified reference in this file, and ns is the SDK's documented
  // top-level namespace (Stripe, Twilio, Aws, ...). Proven forms only:
  //   1. use Ns\A\B;  /  use Ns\A as C;  /  use Ns\{A, B as C};
  //      -> binds the imported class name (or alias) exactly like a JS
  //         named import; instances via `$v = new B(...)` then chain-resolve
  //   2. fully-qualified static call \Ns\A\B::method(...)
  //      -> direct surface, the leading backslash is the root proof
  // Deliberately NOT handled (AST track): unqualified Ns\A::m() relative
  // references (need current-namespace context), variable class names,
  // instances assigned from method returns, and `use function/const`.
  const phpNs = isPhp && Array.isArray(opts.phpNs)
    ? opts.phpNs.filter((p) => moduleNames.includes(p.mod))
    : [];
  // Go module bindings: [{ path, pkg }] from SIGNATURES.goModules, restricted
  // by callers to paths actually imported in this file. The quoted import
  // line is the line-anchored binding proof; the bound identifier is the
  // explicit alias when present, otherwise the package name — the SDK's
  // documented root `pkg` for root imports (Go package names are not
  // derivable from hyphenated module paths), or the last path segment for
  // subpackage imports (`.../v76/charge` -> `charge`, Go's own convention).
  const goMods = isGo && Array.isArray(opts.goMods)
    ? opts.goMods.filter((g) => moduleNames.includes(g.path))
    : [];
  // Ruby constant roots: [{ mod, root }] where mod is the gem name (already
  // proven by a require line — callers only pass gems found in this file) and
  // root is the SDK's top-level constant (e.g. stripe -> Stripe). The require
  // line is the line-anchored binding proof; constants are then resolved the
  // same way JS import bindings are, never by chain shape alone.
  const rbConsts = isRb && Array.isArray(opts.rbConsts)
    ? opts.rbConsts.filter((c) => moduleNames.includes(c.mod))
    : [];
  // Loop 273: Python prose masking — triple-quoted strings (''' / """) are
  // where Python codebases park example code (docstrings, triple-quoted
  // constants); single/double-quoted string CONTENT and trailing `#` comment
  // tails are the other two prose channels on a code line. Lookalike chains
  // in any of them must never bind (false positive). The masker blanks prose
  // characters (offset-preserving — quotes and code stay put) so a triple
  // delimiter opening on one line drops every later body line until the
  // matching delimiter, while code AFTER a same-line closing delimiter still
  // binds. Quote characters inside a string never open a phantom triple, an
  // triple, an escaped quote never closes early, and only the SAME delimiter
  // closes a triple. Loop 274: f-string interpolation slots (`f"...{expr}..."`)
  // are REAL code by Python grammar — the masker now keeps depth-0 slot
  // content unmasked (single-line and triple-quoted f-strings alike), while
  // `{{` / `}}` escapes stay prose, a depth-0 `:` starts the format spec
  // (prose until the closing brace), and non-f strings still mask `{...}`
  // as plain text. Deliberately NOT handled (recorded): slots spanning
  // multiple lines inside triple f-strings (rest of the slot masks as
  // prose — honest miss, rare), quotes nested inside a slot (pre-3.12
  // grammar forbids reusing the outer quote; other quote chars inside a
  // slot are treated as code text), and text-level binding passes that run
  // before this line loop.
  let pyTriple = null; // open descriptor { d: `'''` | `"""`, interp } or null
  // Loop 278: cross-line f-string slot state. Inside a triple-quoted
  // f-string a `{expr}` slot may open on one line and close on a later one
  // (black/ruff wrap long expressions exactly this way) — by Python grammar
  // the whole slot is REAL code (the string pauses, the expression runs).
  // Previously pyCopySlot stopped at end of line and the continuation lines
  // were masked as triple body (false negatives on the very call sites
  // f-strings exist to interpolate — the Python twin of jsTplSlot, Loop
  // 277). `pyTplSlot` carries brace depth + format-spec state across lines;
  // content copies verbatim until the matching `}` pops back to triple-body
  // masking. Only the triple path can set it — single-line strings cannot
  // span lines by grammar (the `stop` fail-safe path clears it).
  let pyTplSlot = null; // { depth, spec } while inside a multi-line f-string slot
  // Loop 275: JS-family prose masking — the same line-level channel set the
  // Ruby (=begin/=end, Loop 272) and Python (Loop 273) tracks already cover
  // was still open for JS/TS: `/* block comments */` (including multi-line
  // bodies — a commented-out example call bound as a real surface), trailing
  // `//` comment tails after code, and single/double-quoted string CONTENT
  // (`"see stripe.balance.retrieve() docs"` minted a surface). All three are
  // masked offset-preserving before the line matchers run. Template-literal
  // `${expr}` slots are REAL code by JS grammar and are copied verbatim
  // (the f-string symmetry, Loop 274); other backtick content masks; a `/*`
  // inside any string never opens a phantom block (a phantom would blackout
  // the rest of the file). Deliberately NOT handled (recorded): multi-line
  // template literals (no cross-line string state — pre-existing documented
  // limitation, unchanged), regex literals containing `/*` (`/^\/*/ ` could
  // open a phantom block — lexer-level division/regex disambiguation is AST
  // track; mitigated by never opening `/*` when the previous non-space char
  // suggests a regex position is NOT possible is out of scope, recorded),
  // and text-level binding passes that run before this line loop.
  let jsBlockComment = false;
  // Loop 276: cross-line template-literal state. A backtick that opens on one
  // line and closes on a later line previously had NO state: body lines were
  // read as code (prose lookalikes bound = false positives) and the CLOSING
  // line's backtick was misread as an OPENER, masking real code after it
  // (false negatives). `jsTemplate` mirrors pyTriple: body content masks,
  // `${}` slots copy verbatim (real code by JS grammar), `\` escapes mask,
  // the closing backtick pops the state. A slot that itself spans lines is
  // an honest miss (same documented limit as pyCopySlot); a nested backtick
  // inside a slot is not tracked (honest miss, recorded).
  let jsTemplate = false;
  // Loop 277: cross-line `${}` slot state. A slot that opens on one line and
  // closes on a later line is real code by JS grammar (the template pauses,
  // the expression runs) — previously the slot scanner stopped at end of
  // line and the continuation lines were masked as template body (false
  // negatives on the very call sites templates exist to interpolate).
  // `jsTplSlot` carries the brace depth across lines; content copies
  // verbatim until the matching `}` pops back to template-body masking.
  // A `}` inside a string literal within the slot closes early (same
  // documented limit as the single-line path); a nested backtick inside a
  // slot is still an honest miss (recorded).
  let jsTplSlot = null; // { depth } while inside a multi-line ${} slot
  // Loop 281: nested backticks inside `${}` slots. A template inside a slot
  // (`` `a ${ fmt(`inner prose`) } b` ``) is a fresh template by JS grammar:
  // its body is prose and must mask, and it may itself carry `${}` slots.
  // The two flat flags (jsTemplate/jsTplSlot) cannot represent nesting, so
  // they are replaced by a frame stack (`jsFrames`, same architecture as the
  // Ruby rbScan frames): 'tpl' frames mask body content (backtick pops,
  // `${` pushes a slot frame), slot frames copy content verbatim (`{`/`}`
  // track depth, the matching `}` pops, a backtick pushes a nested 'tpl'
  // frame). The stack carries across lines, so multi-line nesting works for
  // free. jsTemplate/jsTplSlot remain as thin views kept in sync for the
  // comments above; the scanner reads only the stack. A `}` inside a string
  // literal within a slot still closes early (pre-existing documented
  // limit, fail-safe direction).
  let jsFrames = []; // stack of 'tpl' | { depth } — cross-line template state
  const jsSyncViews = () => {
    const top = jsFrames[jsFrames.length - 1];
    jsTemplate = top === 'tpl';
    jsTplSlot = (top && top !== 'tpl') ? top : null;
  };
  // Consume line content while any template/slot frame is open. Appends to
  // ref.buf (masking or copying per the top frame), returns the index where
  // the stack emptied or the line ended.
  const jsScan = (line, j, ref) => {
    while (j < line.length && jsFrames.length) {
      const top = jsFrames[jsFrames.length - 1];
      const ch = line[j];
      // Loop 287: block comment opened inside a `${}` slot ('cmt' frame).
      // Comment content is prose (mask), may span lines (frame carries),
      // and `*/` pops back to the enclosing slot frame.
      if (top === 'cmt') {
        const end = line.indexOf('*/', j);
        if (end === -1) { ref.buf += ' '.repeat(line.length - j); j = line.length; break; }
        ref.buf += ' '.repeat(end - j) + '  ';
        j = end + 2;
        jsFrames.pop();
        continue;
      }
      if (top === 'tpl') {
        if (ch === '\\') { ref.buf += '  '; j += 2; continue; }
        if (ch === '`') { ref.buf += '`'; j++; jsFrames.pop(); continue; }
        if (ch === '$' && line[j + 1] === '{') {
          ref.buf += '${'; j += 2; jsFrames.push({ depth: 0 }); continue;
        }
        ref.buf += ' '; j++;
        continue;
      }
      // slot frame: content is real code, copy verbatim — except string
      // literals, whose content is prose (mask it) and whose `}`/backtick
      // characters must not affect brace depth or open nested templates
      // (Loop 282: previously `f("x}")` closed the slot early and prose
      // lookalikes inside slot strings minted false surfaces). JS single/
      // double-quoted strings cannot span lines, so this stays
      // line-anchored (unterminated string: mask to end of line, fail-safe).
      if (ch === '"' || ch === "'") {
        ref.buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { ref.buf += '  '; j += 2; continue; }
          if (line[j] === ch) { ref.buf += ch; j++; break; }
          ref.buf += ' '; j++;
        }
        continue;
      }
      if (ch === '`') { ref.buf += '`'; j++; jsFrames.push('tpl'); continue; }
      // Loop 287: comments inside slots. Slot content is code, so `//` and
      // `/*` open real comments there — previously copied verbatim, so a
      // lookalike chain inside a slot comment minted a false surface
      // (probe-verified: `${ // see stripe.x.create(...)` bound), and a
      // multi-line `/* ... */` inside a slot kept its content as fake code.
      // `//` masks to end of line (the slot frame itself carries on — the
      // slot continues on the next line by grammar); `/*` pushes a 'cmt'
      // frame that masks until `*/`, across lines if needed.
      if (ch === '/' && line[j + 1] === '/') {
        ref.buf += ' '.repeat(line.length - j);
        j = line.length;
        break;
      }
      if (ch === '/' && line[j + 1] === '*') {
        ref.buf += '  '; j += 2; jsFrames.push('cmt'); continue;
      }
      // Loop 284: regex literals inside slots. Slot content is code, so a
      // `/` in expression position opens a regex literal here exactly as at
      // top level — its pattern is prose and must mask (previously copied
      // verbatim: pattern lookalikes minted false surfaces, and a `/*`
      // inside a slot regex opened a phantom block comment after the
      // template closed). Division after an operand stays code.
      if (ch === '/' && line[j + 1] !== '/' && line[j + 1] !== '*' && jsRegexPos(ref.buf)) {
        j = jsMaskRegex(line, j, ref);
        continue;
      }
      if (ch === '{') { top.depth++; ref.buf += ch; j++; continue; }
      if (ch === '}') {
        if (top.depth) { top.depth--; ref.buf += ch; j++; continue; }
        ref.buf += '}'; j++; jsFrames.pop(); continue;
      }
      ref.buf += ch; j++;
    }
    jsSyncViews();
    return j;
  };
  // Loop 283: is a `/` at the end of the already-masked prefix `buf` in
  // expression position (regex literal) or after an operand (division)?
  // Standard lexer heuristic: regex after nothing (line start), an operator
  // or opener character, or an expression-position keyword. Division after
  // an identifier, number, `)`, `]`, or `.` — those stay code so real
  // division is never masked. Line-anchored on purpose: a division operand
  // ending the PREVIOUS line (`a /\n pattern-lookalike`) is not tracked —
  // extremely rare formatting, and the mask direction there is fail-safe
  // (masks to end of line, never mints a surface).
  // Loop 284: shared regex-literal masker. Starting at the opening `/`
  // (expression position already adjudicated by jsRegexPos on ref.buf),
  // masks the pattern (prose — lookalike chains inside never bind), skips
  // escapes as two-char units, keeps `/` inside a `[...]` character class
  // from closing, copies trailing flags as-is, and masks to end of line on
  // an unterminated pattern (fail-safe). Used by BOTH the top-level
  // jsMaskLine path (Loop 283) and the `${}` slot frame in jsScan
  // (Loop 284 — slots previously copied regex patterns verbatim, so an
  // unescaped-dot pattern like `/st.coupons.create(/` inside a slot minted
  // a false surface, probe-verified).
  const jsMaskRegex = (line, j, ref) => {
    ref.buf += '/'; j++;
    let inClass = false;
    while (j < line.length) {
      const rc = line[j];
      if (rc === '\\') { ref.buf += '  '; j += 2; continue; }
      if (rc === '[') { inClass = true; ref.buf += ' '; j++; continue; }
      if (rc === ']') { inClass = false; ref.buf += ' '; j++; continue; }
      if (rc === '/' && !inClass) {
        ref.buf += '/'; j++;
        while (j < line.length && /[a-z]/.test(line[j])) { ref.buf += line[j]; j++; }
        break;
      }
      ref.buf += ' '; j++;
    }
    return j;
  };
  const jsRegexPos = (buf) => {
    const t = buf.replace(/\s+$/, '');
    if (!t) return true;
    const c = t[t.length - 1];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(c)) return true;
    const kw = t.match(/([A-Za-z_$][\w$]*)$/);
    if (kw && ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw'].includes(kw[1])) {
      // keyword must be a whole token (the regex above guarantees it ends
      // the prefix; a preceding word char would have been captured too)
      return true;
    }
    return false;
  };
  // Loop 290: Go prose masking. Go was the last scanned language with NO
  // masker at all — probe-verified false positives on all four prose
  // carriers: a trailing `//` comment after real code, a multi-line
  // `/* */` block body, interpreted-string content (`"see x.y.z(a) docs"`),
  // and raw-string (backtick) bodies. Go grammar is the simplest of the
  // set: line comments to EOL, block comments span lines (no nesting),
  // interpreted strings cannot span lines (`\\` escapes), rune literals
  // behave like short strings, and RAW strings span lines with NO escape
  // processing at all (a backslash inside is literal). No regex literals,
  // no interpolation slots — raw-string content is 100% prose.
  let goBlockComment = false; // inside a /* */ block at line start
  let goRawString = false;    // inside a `raw string` at line start
  const goMaskLine = (line) => {
    let buf = '';
    let j = 0;
    while (j < line.length) {
      if (goRawString) {
        const end = line.indexOf('`', j);
        if (end === -1) { buf += ' '.repeat(line.length - j); break; }
        buf += ' '.repeat(end - j) + '`';
        j = end + 1;
        goRawString = false;
        continue;
      }
      if (goBlockComment) {
        const end = line.indexOf('*/', j);
        if (end === -1) { buf += ' '.repeat(line.length - j); break; }
        buf += ' '.repeat(end - j) + '  ';
        j = end + 2;
        goBlockComment = false;
        continue;
      }
      const ch = line[j];
      if (ch === '/' && line[j + 1] === '/') { buf += ' '.repeat(line.length - j); break; }
      if (ch === '/' && line[j + 1] === '*') { goBlockComment = true; buf += '  '; j += 2; continue; }
      if (ch === '"' || ch === "'") {
        // interpreted string / rune literal: keep the quotes, blank content
        buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { buf += '  '; j += 2; continue; }
          if (line[j] === ch) { buf += ch; j++; break; }
          buf += ' '; j++;
        }
        continue;
      }
      if (ch === '`') { buf += '`'; j++; goRawString = true; continue; }
      buf += ch; j++;
    }
    return buf;
  };
  // Loop 299: PHP prose masking. PHP was the last scanned language with NO
  // masker at all — probe-verified false positives on every prose carrier:
  // a block-comment body quoting an old constructor line
  // (`/* $client = new StripeClient($key); */`) minted a phantom $var /
  // $this->field binding and every same-file chain on that name (e.g. a
  // `$client` PARAMETER) was mis-attributed to the SDK; heredoc bodies,
  // `//`/`#` line-comment quotes, and string-literal chain lookalikes
  // (`'$real->prices->create([])'`) all bound too. PHP grammar handled
  // here: `//` and `#` line comments (but `#[` is an attribute, not a
  // comment), `/* */` block comments spanning lines (no nesting),
  // single/double-quoted strings (backslash skips the next char — content
  // blanked, quotes kept), and heredoc/nowdoc bodies (`<<<ID` / `<<<'ID'` /
  // `<<<"ID"` opener must end the line per PHP grammar; body lines are
  // blanked until the `^[ \t]*ID` closer, which is returned as-is — an
  // identifier plus `;`/`)` carries no lookalike risk). Recorded honest
  // limits: interpolated calls inside double-quoted strings/heredocs
  // (`"{$sc->x->y(1)}"`) are masked with the string (a miss, never a
  // phantom), and HTML outside `<?php ?>` is treated as code (no lookalike
  // grammar overlaps PHP chain/binding matchers there).
  let phpBlockComment = false; // inside a /* */ block at line start
  let phpHeredoc = null;       // { id } while inside a heredoc/nowdoc body
  const phpMaskLine = (line) => {
    if (phpHeredoc) {
      if (new RegExp(`^[ \\t]*${phpHeredoc.id}(?![A-Za-z0-9_])`).test(line)) {
        phpHeredoc = null;
        return line; // closer line: identifier + `;`/`)` — no lookalike risk
      }
      return ' '.repeat(line.length); // heredoc/nowdoc body: pure prose
    }
    let buf = '';
    let j = 0;
    while (j < line.length) {
      if (phpBlockComment) {
        const end = line.indexOf('*/', j);
        if (end === -1) { buf += ' '.repeat(line.length - j); break; }
        buf += ' '.repeat(end - j) + '  ';
        j = end + 2;
        phpBlockComment = false;
        continue;
      }
      const ch = line[j];
      if (ch === '/' && line[j + 1] === '/') { buf += ' '.repeat(line.length - j); break; }
      if (ch === '#' && line[j + 1] !== '[') { buf += ' '.repeat(line.length - j); break; }
      if (ch === '/' && line[j + 1] === '*') { phpBlockComment = true; buf += '  '; j += 2; continue; }
      if (ch === '"' || ch === "'") {
        // string literal: keep the quotes, blank content (backslash skips
        // the next char — over-blanking inside a single-quoted string is
        // fail-safe, the content is blanked either way)
        buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { buf += '  '; j += 2; continue; }
          if (line[j] === ch) { buf += ch; j++; break; }
          buf += ' '; j++;
        }
        continue;
      }
      if (ch === '<' && line.slice(j, j + 3) === '<<<') {
        // heredoc/nowdoc opener — PHP grammar requires it to end the line
        const hm = line.slice(j).match(/^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*\r?$/);
        if (hm) { phpHeredoc = { id: hm[1] || hm[2] || hm[3] }; buf += line.slice(j); j = line.length; continue; }
        buf += ch; j++;
        continue;
      }
      buf += ch; j++;
    }
    return buf;
  };
  const jsMaskLine = (line) => {
    let buf = '';
    let j = 0;
    while (j < line.length) {
      if (jsFrames.length) {
        const ref = { buf };
        j = jsScan(line, j, ref);
        buf = ref.buf;
        continue;
      }
      if (jsBlockComment) {
        const end = line.indexOf('*/', j);
        if (end === -1) { buf += ' '.repeat(line.length - j); break; }
        buf += ' '.repeat(end - j) + '  ';
        j = end + 2;
        jsBlockComment = false;
        continue;
      }
      const ch = line[j];
      if (ch === '/' && line[j + 1] === '/') { buf += ' '.repeat(line.length - j); break; }
      if (ch === '/' && line[j + 1] === '*') { jsBlockComment = true; buf += '  '; j += 2; continue; }
      // Loop 283: regex literals. A `/` in expression position opens a regex
      // literal, not division — its PATTERN is prose (lookalike chains inside
      // it minted false surfaces) and a `/*` inside it opened a phantom block
      // comment that blacked out the rest of the file (probe-verified false
      // negative, the Loop 269 propagation shape). Expression position is the
      // standard lexer heuristic: start of line, or the previous non-space
      // char is an operator/opener, or the previous token is a keyword like
      // `return`/`typeof`. After an identifier, `)`, or `]` the `/` is
      // division and stays code. Escapes skip the next char, `/` inside a
      // character class does not close, trailing flags copy as-is. Regex
      // literals cannot span lines by grammar — an unterminated pattern
      // masks to end of line (fail-safe). Loop 284: regex literals inside
      // `${}` slot frames are handled the same way in jsScan (shared
      // jsMaskRegex — slots previously copied patterns verbatim).
      if (ch === '/' && jsRegexPos(buf)) {
        const ref = { buf };
        j = jsMaskRegex(line, j, ref);
        buf = ref.buf;
        continue;
      }
      if (ch === '"' || ch === "'") {
        buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { buf += '  '; j += 2; continue; }
          if (line[j] === ch) { buf += ch; j++; break; }
          buf += ' '; j++;
        }
        continue;
      }
      if (ch === '`') {
        buf += ch; j++;
        jsFrames.push('tpl');
        const ref = { buf };
        j = jsScan(line, j, ref);
        buf = ref.buf;
        continue;
      }
      buf += ch; j++;
    }
    return buf;
  };
  // Copy an interpolation slot verbatim starting at the `{` (index j), or
  // resume a slot continuation line when `resume` carries {depth, spec}
  // (Loop 278 — j then points at the first char of the line, no `{` to
  // consume). Returns the new index; appends to outRef.buf. Depth-0 `:`
  // flips to format-spec masking. `stop` (optional) aborts the slot when the
  // enclosing single-line string's quote char is seen at slot depth 0
  // (malformed source — fail safe back to string masking). Running off the
  // line without `stop` (triple-quoted path) records the open slot in
  // pyTplSlot so the next body line resumes as code (Loop 278); with `stop`
  // (single-line path) it stays an honest single-line fail-safe.
  const pyCopySlot = (line, j, outRef, stop, resume) => {
    let depth = resume ? resume.depth : 0;
    let spec = resume ? resume.spec : false;
    if (!resume) { outRef.buf += '{'; j++; }
    pyTplSlot = null;
    while (j < line.length) {
      const ch = line[j];
      // Loop 285: string literals inside a slot. Slot content is code, but a
      // quoted string inside it is PROSE — previously copied verbatim, so a
      // lookalike chain inside it minted a surface (probe-verified:
      // `f"note: {t('see stripe.X.create() docs')}"` bound). Different-quote
      // nesting is legal in every Python version; SAME-quote nesting is only
      // legal on 3.12+ — under pre-3.12 grammar the outer string would end
      // there, making everything after a syntax error, so the 3.12
      // nested-string reading is the only coherent one and masking it is
      // also the fail-safe direction (a miss, never a false surface). The
      // string's `}` / `{` / `:` characters no longer affect slot state.
      // Unterminated nested string masks to end of line (fail-safe); the
      // single-line path (`stop` set) still never carries state across
      // lines. Triple-quoted strings inside a slot are handled below (Loop
      // 289); multi-line ones stay an honest miss.
      // Loop 289: triple-quoted strings inside a slot. Previously the opening
      // quote was read as a 1-char string (`'` then `''` empty) and the body
      // was treated as slot code — a lookalike chain inside it minted a
      // surface (false positive, probe-verified), and an apostrophe in the
      // body (`'''it's'''`) desynced the string state so a REAL call later in
      // the same slot went silent (false negative, probe-verified). Mask the
      // whole triple-quoted body; an unterminated one masks to end of line
      // (fail-safe — a multi-line triple inside a slot stays an honest miss,
      // never a phantom surface).
      if (!spec && (ch === '"' || ch === "'") && line.startsWith(ch + ch + ch, j)) {
        outRef.buf += ch + ch + ch; j += 3;
        while (j < line.length) {
          if (line[j] === '\\') { outRef.buf += '  '; j += 2; continue; }
          if (line.startsWith(ch + ch + ch, j)) { outRef.buf += ch + ch + ch; j += 3; break; }
          outRef.buf += ' '; j++;
        }
        continue;
      }
      if (!spec && (ch === '"' || ch === "'")) {
        outRef.buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { outRef.buf += '  '; j += 2; continue; }
          if (line[j] === ch) { outRef.buf += ch; j++; break; }
          outRef.buf += ' '; j++;
        }
        continue;
      }
      if (ch === '}') {
        if (depth) { depth--; outRef.buf += spec ? ' ' : ch; j++; continue; }
        outRef.buf += '}'; j++; return j;
      }
      if (ch === '{') { depth++; outRef.buf += spec ? ' ' : ch; j++; continue; }
      if (!spec && depth === 0 && ch === ':') { spec = true; outRef.buf += ' '; j++; continue; }
      if (!spec && depth === 0 && stop && ch === stop) return j; // malformed: let caller re-handle
      outRef.buf += spec ? ' ' : ch;
      j++;
    }
    // Slot ran off the line. Triple-quoted f-strings legally continue the
    // expression on the next line — carry the state (Loop 278). Single-line
    // strings cannot span lines: stay a fail-safe honest miss.
    if (!stop) pyTplSlot = { depth, spec };
    return j;
  };
  const pyMaskLine = (line) => {
    const ref = { buf: '' };
    let j = 0;
    while (j < line.length) {
      if (pyTriple) {
        if (pyTplSlot) { // Loop 278: slot continuation line — code, verbatim
          j = pyCopySlot(line, j, ref, undefined, pyTplSlot);
          continue; // slot closed -> triple-body masking resumes below
        }
        if (line.startsWith(pyTriple.d, j)) { ref.buf += pyTriple.d; j += 3; pyTriple = null; continue; }
        if (line[j] === '\\') { ref.buf += '  '; j += 2; continue; }
        if (pyTriple.interp && line[j] === '{') {
          if (line[j + 1] === '{') { ref.buf += '  '; j += 2; continue; } // {{ escape
          j = pyCopySlot(line, j, ref);
          continue;
        }
        if (pyTriple.interp && line[j] === '}' && line[j + 1] === '}') { ref.buf += '  '; j += 2; continue; }
        ref.buf += ' '; j++; continue;
      }
      const ch = line[j];
      if (ch === '#') { ref.buf += ' '.repeat(line.length - j); break; } // comment tail is prose
      if (ch === '"' || ch === "'") {
        // string prefix (f/r/b/u, up to two chars) decides interpolation
        let p = j - 1, pref = '';
        while (p >= 0 && /[A-Za-z]/.test(line[p]) && pref.length < 2) { pref = line[p] + pref; p--; }
        const interp = /f/i.test(pref) && !(p >= 0 && /[\w.]/.test(line[p]) && pref.length === 2);
        if (line.startsWith(ch + ch + ch, j)) { pyTriple = { d: ch + ch + ch, interp }; ref.buf += pyTriple.d; j += 3; continue; }
        // single-line string: keep the quotes, blank the content — string
        // lookalikes never bind, and blanked parens can no longer derail
        // the balanced-paren chain scan. f-string slots stay code.
        ref.buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\') { ref.buf += '  '; j += 2; continue; }
          if (line[j] === ch) { ref.buf += ch; j++; break; }
          if (interp && line[j] === '{') {
            if (line[j + 1] === '{') { ref.buf += '  '; j += 2; continue; } // {{ escape
            j = pyCopySlot(line, j, ref, ch);
            continue;
          }
          if (interp && line[j] === '}' && line[j + 1] === '}') { ref.buf += '  '; j += 2; continue; }
          ref.buf += ' '; j++;
        }
        continue;
      }
      ref.buf += ch; j++;
    }
    return ref.buf;
  };
  // Ruby heredoc bodies are prose: track the opener (`<<~ID` / `<<-ID` /
  // `<<ID`) and skip lines until the terminator. Line-anchored state — the
  // opener and the terminator are each single-line facts.
  // Multiple openers on ONE line (`build(<<~SQL, <<~DOC)`) queue their bodies
  // back-to-back in source order (Ruby grammar): track a FIFO of pending
  // terminators, not a single id (Loop 268 — single-id tracking resumed code
  // position after the FIRST terminator, misreading every later body as code
  // = false-positive path).
  // Entries: { id, interp } — interp is true for bare (`<<~SQL`) and
  // double-quoted (`<<-"DOC"`) delimiters whose bodies INTERPOLATE by Ruby
  // grammar (`#{...}` inside is real code, Loop 270), false for
  // single-quoted delimiters (`<<~'SQL'`) which never interpolate.
  const rbHeredocQ = []; // pending heredoc descriptors, FIFO
  // Loop 272: `=begin` / `=end` block comments. Ruby grammar: both markers
  // must sit at COLUMN 0 (an indented `=begin` is a syntax error, never a
  // comment) and may carry trailing text. Everything between them is prose —
  // chains inside must never bind (false positive) and heredoc-opener
  // lookalikes inside must never enqueue a phantom terminator (which would
  // blackout the rest of the file = whole-file false negative). A line
  // starting with `=begin` INSIDE an open heredoc body is string content,
  // not a comment marker — the heredoc queue check runs first.
  let rbBlockComment = false;
  // Shared Ruby code/prose adjudicator (frame stack — see the long comment at
  // the rbCodePosition call sites below). Returns true when idx sits at code
  // position: top-level statement text or inside an open `#{ }` interpolation
  // frame; false inside string content or after an unquoted `#` comment
  // marker. Used both by the chain matchers AND (Loop 269) by the heredoc
  // opener scan: an opener lookalike inside a string (`s = "<<~SQL"`) or a
  // comment (`# use <<~SQL`) must never enqueue a phantom terminator —
  // before this guard the phantom entry swallowed EVERY later line of the
  // file (terminator never arrives) = whole-file false-negative blackout.
  // Loop 270: `inString` starts the scan inside a double-quoted string frame —
  // used for INTERPOLATING heredoc body lines, where the whole line is string
  // content except `#{ }` slots (which are code position).
  // Loop 271: percent-literal frames. `%q(...)` / `%Q(...)` / `%w[...]` /
  // `%{...}` are string/array literals by Ruby grammar — chains inside them
  // are prose (embedded SQL, doc snippets, word lists), and `#{ }` slots
  // inside the INTERPOLATING variants (%Q %W %I %x %r and bare %) are real
  // code. Lettered forms are literals unless the `%` is glued to an operand
  // (`a%q(x)` lexes as modulo); bare `%` is a literal only when the previous
  // non-space char is not an operand end (`total % (count)` stays modulo,
  // `sql = %(...)` opens). Paired delimiters nest per Ruby grammar.
  const RB_PCT_PAIR = { '(': ')', '[': ']', '{': '}', '<': '>' };
  // Loop 279: cross-line string state. Ruby double/single-quoted strings,
  // percent literals AND `#{ }` interpolation slots all span lines by
  // grammar — a slot opened on one line (`msg = "x: #{`) makes the NEXT
  // lines real code until the matching `}`, and string content after the
  // slot closes is prose until the closing quote. The adjudicator was
  // line-anchored (state reset every line), so multi-line slot bodies were
  // invisible (false negative) and post-slot string prose mis-bound (false
  // positive — probed live before this fix). The frame stack now CARRIES
  // across lines: rbCarry holds the open frames at the start of the next
  // top-level line, and each interpolating heredoc descriptor holds its own
  // body-line frames (a heredoc body is an independent string context).
  // Frames are cloned per adjudication call so per-index probes never
  // corrupt the carried state. A `#` at code position starts a comment to
  // end-of-line (frames unchanged); `=begin` only opens a block comment at
  // column 0 with NO open frames (inside a string it is content; inside an
  // open slot we stay fail-safe and treat it as code text — recorded).
  const rbCloneFrames = (st) => st.map((f) => (typeof f === 'object' ? { ...f } : f));
  // Scan line[0..idx) starting from `init` frames. Returns { stack, comment }:
  // the frame stack at idx and whether an unquoted `#` comment marker was
  // crossed at code position (everything after it is prose, frames frozen).
  // Loop 286: Ruby regex literals (`/pattern/`). Same defect family as the
  // JS lines (Loop 283/284, probe-verified live): pattern prose with a
  // constant-chain lookalike minted a false surface; a `#` inside a pattern
  // was read as a comment marker (code after it on the same line went
  // invisible); an unpaired quote inside a pattern opened a phantom string
  // frame that carried across lines and blacked out the rest of the file
  // (the Loop 269 propagation shape). A `/` at code position opens a regex
  // when the previous significant token allows an expression there —
  // standard lexer heuristic mirroring jsRegexPos: line start, an operator/
  // opener char, or an expression-position keyword (`return`, `when`,
  // `and`…). After an operand (identifier, `)`, `]`, closing quote) the `/`
  // is division and stays plain code. Pattern content is prose EXCEPT
  // `#{ }` interpolation slots (real code by Ruby grammar, same as string
  // frames); `/` inside a `[...]` character class does not close; trailing
  // flag letters are consumed with the closer. Ruby regexes CAN span lines
  // (`/a\n b/x`) but a division operand split across lines is the same
  // ambiguity in reverse — an open regex frame is therefore NOT carried to
  // the next top-level line (rbStripRx below): unterminated patterns mask
  // to end of line only, the JS fail-safe direction (recorded limitation).
  const RB_RX_KW = new Set(['return', 'and', 'or', 'not', 'when', 'if', 'unless', 'while', 'until', 'case', 'then', 'do', 'else', 'elsif', 'begin', 'rescue', 'ensure', 'yield', 'break', 'next']);
  const rbRegexPos = (prev, word) => {
    if (!prev) return true; // start of statement text
    if (/[A-Za-z0-9_]/.test(prev)) return RB_RX_KW.has(word);
    return '(,=[{;|&!<>+-*%?:^~'.includes(prev);
  };
  const rbScan = (line, idx, init) => {
    const stack = rbCloneFrames(init); // frames: "'" | '"' (string content) | '{' (interp code) | {close,rx?,...} (percent literal / regex)
    let prev = ''; // last significant code-position char (regex/division disambiguation)
    let word = ''; // trailing identifier at code position (keyword check)
    for (let j = 0; j < idx; j++) {
      const ch = line[j];
      const top = stack[stack.length - 1];
      if (top === "'") {
        if (ch === '\\') { j++; continue; } // \' and \\ escapes
        if (ch === "'") { stack.pop(); prev = ')'; word = ''; }
      } else if (top === '"') {
        if (ch === '\\') { j++; continue; } // \" and \#{ escapes
        if (ch === '"') { stack.pop(); prev = ')'; word = ''; }
        else if (ch === '#' && line[j + 1] === '{') { stack.push('{'); j++; }
      } else if (top && typeof top === 'object') {
        if (ch === '\\') { j++; continue; } // \) \/ and \\ escapes
        if (top.rx) {
          // regex pattern content: prose except `#{ }` slots; `[...]`
          // character class suspends the closer; flags consume with it
          if (ch === '[') { top.cls = true; continue; }
          if (ch === ']') { top.cls = false; continue; }
          if (ch === '/' && !top.cls) {
            stack.pop();
            let k = j + 1; while (k < idx && /[a-z]/.test(line[k])) k++;
            j = k - 1; prev = ')'; word = '';
            continue;
          }
          if (ch === '#' && line[j + 1] === '{') { stack.push('{'); j++; }
          continue;
        }
        // percent-literal content frame
        // Loop 288: %r percent-regexes have REGEX grammar inside — a `[...]`
        // character class suspends delimiter counting (probe-verified live:
        // `%r{[^}]*X.create(x)}` popped the frame at the class `}` and the
        // pattern tail minted a false surface; `%r{[{]x}` bumped the nesting
        // depth on the class `{` so the frame never closed and blacked out
        // the rest of the file — the Loop 269 propagation shape). Only when
        // the delimiter itself is not a bracket pair: with `%r[...]` the
        // class brackets are indistinguishable from delimiters (Ruby counts
        // nesting there too), so bracket-delimited %r keeps plain pairing.
        if (top.rxcls !== undefined) {
          if (!top.rxcls && ch === '[') { top.rxcls = true; continue; }
          if (top.rxcls) {
            if (ch === ']') top.rxcls = false;
            else if (top.interp && ch === '#' && line[j + 1] === '{') { stack.push('{'); j++; }
            continue;
          }
        }
        if (top.open && ch === top.open) { top.depth++; continue; } // nested pair
        if (ch === top.close) { if (top.depth) top.depth--; else { stack.pop(); prev = ')'; word = ''; } continue; }
        if (top.interp && ch === '#' && line[j + 1] === '{') { stack.push('{'); j++; }
      } else {
        // code position: file top level (stack empty) or interp frame
        if (ch === "'" || ch === '"') stack.push(ch);
        else if (ch === '/' && rbRegexPos(prev, word)) {
          // Loop 344: a regex opened directly after `=` is unambiguous —
          // `x = /` can never be division in Ruby grammar, so this frame is
          // safe to CARRY across lines (multi-line /x regexes are the
          // dominant form: `V = /\n  pattern\n/x`). Before this, the body of
          // such a regex was rescanned as code on the next line and a
          // binding lookalike inside the pattern minted a phantom instance
          // whose chains became false sdk-call surfaces (probe-verified
          // live, /tmp/probe-l344/pf). Loop 345 extends the carry to `(`
          // and `,` openers: a `/` directly after an open paren or an
          // argument comma has no left operand either (`gsub(/.../x)` and
          // `scan(1, /.../x)` argument regexes are equally unambiguous;
          // probe-verified phantom surfaces before the fix). Loop 346 extends
          // the carry to `[` (array element), `{` (hash literal / block),
          // `|` (boolean/bitwise alternation) and `~` (the `=~` match
          // operator / unary complement) openers — none of these has a
          // left operand either (probe-verified phantom surfaces before the
          // fix). `?` and `:` are deliberately excluded: glued `?/` is a
          // character literal and `:/` is a symbol, so a carried frame there
          // would blackout real code. Openers in any other position
          // (line-start `/` is ambiguous with a continuation division — the
          // recorded Loop 286 reverse ambiguity) keep the fail-safe
          // mask-to-EOL behaviour.
          stack.push({ rx: true, cls: false, carry: prev === '=' || prev === '(' || prev === ',' || prev === '[' || prev === '{' || prev === '|' || prev === '~' }); word = '';
        }
        else if (ch === '%') {
          const pm = /^%([qQwWiIsxr]?)([^\sA-Za-z0-9])/.exec(line.slice(j));
          if (pm) {
            const prevCh = j > 0 ? line[j - 1] : '';
            let k = j - 1; while (k >= 0 && /\s/.test(line[k])) k--;
            const prevNs = k >= 0 ? line[k] : '';
            const operand = (c) => /[\w)\]}"']/.test(c);
            // lettered: literal unless glued to an operand (a%q -> modulo);
            // bare: literal only when nothing operand-like precedes it.
            const isLit = pm[1] ? !operand(prevCh) : !operand(prevNs);
            if (isLit) {
              const open = pm[2];
              const paired = Object.prototype.hasOwnProperty.call(RB_PCT_PAIR, open);
              stack.push({
                close: paired ? RB_PCT_PAIR[open] : open,
                open: paired ? open : null,
                depth: 0,
                interp: !(pm[1] === 'q' || pm[1] === 'w' || pm[1] === 'i' || pm[1] === 's'),
                // Loop 288: %r has regex grammar — enable char-class masking
                // unless the delimiter IS brackets (then class brackets are
                // indistinguishable from delimiters; Ruby nests them anyway).
                ...(pm[1] === 'r' && open !== '[' ? { rxcls: false } : {}),
              });
              j += pm[0].length - 1;
            }
            // otherwise modulo/format operator: plain code char
          }
        }
        else if (ch === '#') return { stack, comment: true }; // comment to EOL (frames frozen)
        else if (ch === '{' && top === '{') stack.push('{'); // nested brace in interp
        else if (ch === '}' && top === '{') stack.pop(); // interp (or nested) close
        // track the last significant char + trailing identifier at code
        // position (regex/division disambiguation, Loop 286)
        if (!/\s/.test(ch)) {
          prev = ch;
          word = /[A-Za-z0-9_]/.test(ch) ? word + ch : '';
        }
      }
    }
    return { stack, comment: false };
  };
  // Adjudicator: idx is code position iff no comment marker was crossed and
  // the frame at idx is top-level or an open `#{ }` slot.
  const rbCodeAt = (line, idx, init = []) => {
    const r = rbScan(line, idx, init);
    if (r.comment) return false;
    const top = r.stack[r.stack.length - 1];
    return top === undefined || top === '{';
  };
  // Loop 286: text-level binding-pass prose guard. The module-binding
  // matchers below scan the RAW text, so an example import living inside a
  // multi-line prose container (Python docstring / triple-quoted constant,
  // JS block comment, JS template-literal body) minted a real binding —
  // and every same-file lookalike chain rooted at that name then minted
  // false surfaces (probe-verified: a docstring-only `import stripe` bound
  // and a top-level `stripe.Charge.retrieve(...)` lookalike in the same
  // file produced an sdk-call surface with no real import anywhere).
  // The pre-pass below walks the existing line maskers once (the maskers
  // were hoisted above unchanged) to record, per line, whether it STARTS
  // inside such a container; module-binding matchers whose match starts on
  // a prose line are skipped. The masked lines are stored and reused by the
  // main line loop (single walk, single adjudicator — no drift), and the
  // cross-line masker state is reset in between. Same-line prose (comment
  // tails, quoted strings) needs no guard here: those matchers are
  // line-anchored or quote-delimited, so a same-line lookalike cannot
  // match at line start. A real import on the CLOSING line of a container
  // (`*/ import ...`) is skipped too — fail-safe direction (a miss, never
  // a phantom binding), vanishingly rare formatting. PHP joined the
  // pre-pass in Loop 299 (phpMaskLine — line/block comments, string
  // literals, heredoc/nowdoc bodies all masked; the PHP binding matchers
  // below run over the masked text, so prose lookalikes never mint a
  // $var / $this->field binding). Go joined the pre-pass in Loop 290
  // (goMaskLine — comments,
  // interpreted strings, multi-line raw strings all masked). Ruby joined
  // in Loop 298 (heredoc bodies, =begin/=end block comments, and carried
  // string/percent-literal frames all mark prose line starts — the Ruby
  // machinery above is hoisted so rbScan/rbCodeAt serve both walks).
  const preLines = text.split('\n');
  let maskedLines = null;
  const proseLineStarts = new Uint8Array(preLines.length);
  if (isPy || isGo || isPhp || !isRb) {
    maskedLines = new Array(preLines.length);
    for (let li = 0; li < preLines.length; li++) {
      proseLineStarts[li] = isPy
        ? (pyTriple !== null && !pyTplSlot ? 1 : 0)
        : isGo
          ? ((goBlockComment || goRawString) ? 1 : 0)
          : isPhp
            ? ((phpBlockComment || phpHeredoc) ? 1 : 0)
            : ((jsBlockComment || jsFrames[jsFrames.length - 1] === 'tpl' || jsFrames[jsFrames.length - 1] === 'cmt') ? 1 : 0);
      maskedLines[li] = isPy ? pyMaskLine(preLines[li]) : isGo ? goMaskLine(preLines[li]) : isPhp ? phpMaskLine(preLines[li]) : jsMaskLine(preLines[li]);
    }
    // reset cross-line state: the main line loop reuses maskedLines, so no
    // stale frames may leak into the Ruby path or a second walk
    pyTriple = null; pyTplSlot = null; jsBlockComment = false;
    jsFrames = []; jsSyncViews();
    goBlockComment = false; goRawString = false;
    phpBlockComment = false; phpHeredoc = null;
  }
  if (isRb && rbConsts.length) {
    // Loop 298: Ruby pre-pass — mark lines that START inside a prose
    // container (heredoc body, `=begin`/`=end` block comment, carried
    // string / percent-literal frame) so the text-level Ruby binding
    // matchers below (rbInstances / rbIvars `.new` assignments, which scan
    // the RAW text with `gm` regexes) can skip prose lookalikes via
    // bindingProseGuard. Before this, a quoted migration note
    // (`=begin ... client = Stripe::StripeClient.new(key) ... =end` or the
    // same line inside a heredoc body) minted a phantom instance and every
    // same-file chain on that name (e.g. a `client` PARAMETER) was
    // mis-attributed to the SDK — probe-verified live (/tmp/l298p).
    // Mirrors the main line loop's state sequence (same rbScan, same
    // heredoc-queue semantics, same regex-frame stripping); private local
    // state so the main loop still starts clean.
    let preCarry = [];
    const preHdQ = [];
    let preBlock = false;
    const preStripRx = (st) => st.filter((f) => !(typeof f === 'object' && f.rx && !f.carry));
    for (let li = 0; li < preLines.length; li++) {
      const l = preLines[li];
      if (preHdQ.length) {
        proseLineStarts[li] = 1; // heredoc body (or terminator) line
        if (new RegExp(`^\\s*${preHdQ[0].id}\\s*$`).test(l)) { preHdQ.shift(); continue; }
        if (!preHdQ[0].interp) continue;
        const end = rbScan(l, l.length, preHdQ[0].frames || ['"']);
        preHdQ[0].frames = preStripRx(end.stack);
        continue;
      }
      const init = preCarry;
      const top = init[init.length - 1];
      // line starts inside carried string/percent content (a `#{ }` slot at
      // line start is code position and stays unmarked)
      if (preBlock || (top !== undefined && top !== '{')) proseLineStarts[li] = 1;
      if (!init.length) {
        if (preBlock) {
          proseLineStarts[li] = 1;
          if (/^=end\b/.test(l)) preBlock = false;
          continue;
        }
        if (/^=begin\b/.test(l)) { preBlock = true; proseLineStarts[li] = 1; continue; }
      }
      const end = rbScan(l, l.length, init);
      preCarry = preStripRx(end.stack);
      for (const hd of l.matchAll(/<<[~-]?(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Z_][A-Z0-9_]*)\b)/g)) {
        if (!rbCodeAt(l, hd.index, init)) continue;
        preHdQ.push({ id: hd[1] || hd[2] || hd[3], interp: !hd[1] });
      }
    }
  }
  // line-number lookup for raw-text match indices (binary search)
  const lineOffsets = new Array(preLines.length);
  {
    let off = 0;
    for (let li = 0; li < preLines.length; li++) { lineOffsets[li] = off; off += preLines[li].length + 1; }
  }
  const lineNoOf = (idx) => {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineOffsets[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };
  // true when a raw-text match starts on a line that begins inside a
  // multi-line prose container — such a match is prose, never a binding
  const bindingProseGuard = (m) => proseLineStarts[lineNoOf(m.index)] === 1;

  // module -> local binding names. `named` marks bindings introduced through
  // a named-import / destructured-require list — instances constructed from
  // those (e.g. `new OrdersController(client)`) get a controller-call surface
  // in addition to the normalized sdk-call surface, because controller-style
  // migration packs anchor on the *variable name*, not the client chain.
  const bindings = new Map(); // localName -> { mod, named }
  for (const mod of moduleNames) {
    const e = escapeRe(mod);
    // import Default from 'mod'  /  import * as NS from 'mod'
    for (const m of text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?([A-Za-z_$][\\w$]*)\\s+from\\s+['"]${e}['"]`, 'g'))) { if (bindingProseGuard(m)) continue; bindings.set(m[1], { mod, named: false }); }
    // const X = require('mod')
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*['"]${e}['"]\\s*\\)`, 'g'))) { if (bindingProseGuard(m)) continue; bindings.set(m[1], { mod, named: false }); }
    // import { A, B } from 'mod'  /  const { A, B } = require('mod')  — named bindings
    const namedLists = [
      ...text.matchAll(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s+['"]${e}['"]`, 'g')),
      ...text.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*require\\(\\s*['"]${e}['"]\\s*\\)`, 'g')),
    ];
    for (const m of namedLists) {
      if (bindingProseGuard(m)) continue;
      for (const part of m[1].split(',')) {
        const name = part.split(/\bas\b|:/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) bindings.set(name, { mod, named: true });
      }
    }
    // Python module bindings — only for modules whose package name is itself a
    // valid Python identifier (npm name == pypi name, e.g. `stripe`, `openai`,
    // `plaid`). `import mod` / `import mod as alias` bind the module object as
    // a chain root, so `stripe.checkout.sessions.create(...)` is inventoried.
    // `from mod import Thing` / `from mod import A, B as C` binds the named
    // class/function exactly like a JS named import: the binding is proven by
    // the import line itself (never by chain shape), so instances constructed
    // from it can be resolved with the same two-step proof the JS side uses.
    // Deliberately NOT handled (recorded as pitfalls, AST-track candidates):
    //   - instance variables assigned from *deep* module chains
    //     (`sess = stripe.checkout.sessions.create(...)`) — the returned value
    //     is API data, not a client; binding it would be chain-shape guessing.
    //     Depth-1 module-attribute construction (`client = stripe.StripeClient(...)`,
    //     `s3 = boto3.client("s3")`) IS handled below: the chain root is a
    //     proven module binding, so the assignment line itself is the proof.
    //   - re-exports / aliasing through intermediate variables
    if (/^[A-Za-z_]\w*$/.test(mod)) {
      for (const m of text.matchAll(new RegExp(`^[ \\t]*import\\s+${e}(?:\\s+as\\s+([A-Za-z_]\\w*))?\\s*(?:#.*)?$`, 'gm'))) {
        if (bindingProseGuard(m)) continue;
        bindings.set(m[1] || mod, { mod, named: false, pyModule: true });
      }
      // from mod import A, B as C — single-line lists AND parenthesized
      // (possibly multi-line) lists. Both forms are line-anchored binding
      // proofs: the import statement itself opens the match, and `)` cannot
      // legally appear inside an import name list, so `\(([^)]*)\)` captures
      // the whole parenthesized block without guessing. Per-entry `#` line
      // comments inside the block are stripped before name parsing. Gated to
      // Python files only: a JS file can never legally carry this statement,
      // so any hit there would be string/prose content — never a binding.
      // Still left to the AST track: re-exports / aliasing through
      // intermediate variables and `import importlib`-style dynamic imports.
      if (isPy) {
        const fromImportLists = [
          ...text.matchAll(new RegExp(`^[ \\t]*from\\s+${e}\\s+import\\s+([A-Za-z_]\\w*(?:\\s+as\\s+[A-Za-z_]\\w*)?(?:\\s*,\\s*[A-Za-z_]\\w*(?:\\s+as\\s+[A-Za-z_]\\w*)?)*)\\s*(?:#.*)?$`, 'gm')),
          ...text.matchAll(new RegExp(`^[ \\t]*from\\s+${e}\\s+import\\s*\\(([^)]*)\\)`, 'gm')),
        ];
        for (const m of fromImportLists) {
          if (bindingProseGuard(m)) continue;
          for (const part of m[1].split(',')) {
            // strip per-line comments inside parenthesized blocks
            const clean = part.replace(/#.*$/gm, '').trim();
            if (!clean) continue; // trailing comma / comment-only line
            const toks = clean.split(/\s+as\s+/);
            const name = (toks[1] || toks[0]).trim();
            // named:false — Python instances must NOT emit controller-call
            // companion surfaces: controller packs anchor JS `new Ctor(...)`
            // rewrites and joining Python sites to them would be a false match.
            if (/^[A-Za-z_]\w*$/.test(name)) bindings.set(name, { mod, named: false, pyClass: true });
          }
        }
      }
    }
  }
  // Go package bindings — for each proven import path, resolve the local
  // identifier: explicit alias when written (`stripe "github.com/stripe/stripe-go/v76"`),
  // otherwise the documented root pkg for root/version-only imports, or the
  // last path segment for subpackage imports (`.../v76/charge` -> charge,
  // Go's package-name-equals-directory convention). Blank (`_`) and dot (`.`)
  // imports never bind: blank imports are side-effect only, and dot imports
  // put names in file scope where chain resolution would be guessing (AST
  // track). Gated to .go files: the same quoted path inside another language
  // is string content, never a binding.
  if (isGo) {
    for (const { path: goPath, pkg } of goMods) {
      const e = escapeRe(goPath);
      for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:import\\s+)?(?:([A-Za-z_]\\w*)\\s+)?"${e}((?:/[\\w.-]+)*)"`, 'gm'))) {
        // Loop 291: prose guard — an import line quoted inside a block
        // comment or a raw-string body (migration notes are the dominant
        // carrier) must never mint a binding: a same-named local variable
        // would have its whole call surface falsely attributed to the SDK.
        // Same guard the JS/Python import matchers use; single-line comment
        // lookalikes can't match at all (the `^[ \t]*` anchor rejects them).
        if (bindingProseGuard(m)) continue;
        const alias = m[1];
        if (alias === '_') continue; // blank import: side effect only, no binding
        const segs = (m[2] || '').split('/').filter(Boolean);
        const sub = segs.filter((s) => !/^v\d+$/.test(s));
        const name = alias || (sub.length ? sub[sub.length - 1] : pkg);
        if (/^[A-Za-z_]\w*$/.test(name)) bindings.set(name, { mod: goPath, named: false, goPkg: true });
      }
    }
  }
  if (!bindings.size && !rbConsts.length && !phpNs.length && !externalRoots.length && !nsRoots.length) return [];

  // instance vars: const client = new Binding(...)  or  const client = Binding(...)
  // The constructing binding is kept per instance so controller-style packs
  // (anchored on `new NamedImport(...)` instance variables) can be joined
  // precisely — see matchSdkCalls.
  // An optional TypeScript type annotation between the identifier and `=`
  // (`const stripe: Stripe = new Stripe(...)`) is the dominant typed-TS idiom
  // (the TS mirror of the Python PEP 526 slot above) and carries the exact
  // same proof — the annotation is a dotted name with an optional generic
  // argument list and never contains `=`, so ternaries (`cond ? new X(...)`,
  // whose `=` precedes the `?`) and object-literal entries (no `=`) can never
  // match. Union/intersection annotations (`Stripe | null`) are honestly not
  // bound — rare on the construction line itself, never guess.
  const instances = new Map(); // varName -> { mod, ctor, named }
  // Loop 373: declaration indices of Loop 372 field aliases — the alias
  // declaration (`const sc = services.sc;`) is its own proof and must be
  // exempted from the plain-local rebinding guard below. Both matchers
  // anchor at the same statement-start / `{;` inline position, so the
  // recorded index aligns exactly with the guard's match index.
  const jsAliasProvenIdx = new Set();
  // Loop 231: prose guard for the (non-line-anchored) Python walrus matcher —
  // a `#` comment opener or an unclosed quote (odd count of ' / ") in the
  // same-line prefix skips the match. Commented or in-string lookalikes must
  // never mint a binding; prefer missing a binding over guessing.
  const pyWalrusProseGuard = (m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const prefix = text.slice(lineStart, m.index);
    if (prefix.includes('#')) return true;
    for (const q of ["'", '"']) {
      if ((prefix.split(q).length - 1) % 2 === 1) return true;
    }
    return false;
  };
  // Loop 234: JS flavour of the same-line prose guard (comment openers are
  // `//` / `/*`, quote set includes backticks) — used by the inline
  // deferred-assignment matcher below. Same shape as the Loop 212 guard.
  const jsInlineProseGuard = (m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const prefix = text.slice(lineStart, m.index);
    if (/\/\/|\/\*/.test(prefix)) return true;
    for (const q of ["'", '"', '`']) {
      if ((prefix.split(q).length - 1) % 2 === 1) return true;
    }
    return false;
  };
  // Loop 311: Python conditional-expression arm guard — the Python mirror of
  // the JS both-arms ternary verdict (Loop 304). The bare-assignment /
  // walrus / self-field matchers all match on the RHS *prefix*
  // (`= OpenAI(`), so a conditional expression whose else arm is arbitrary
  // (`client = OpenAI(k) if use_real else make_fake()`) used to bind — but
  // the bound name is only *sometimes* the proven construction. Verdict:
  // when the RHS is a conditional expression, bind ONLY if the else arm is
  // the SAME proven construction (both-arms — `OpenAI(t) if cond else
  // OpenAI(l)`, the test/live-key idiom); any other else arm (fake factory,
  // None, different root) is a skip — never guess (false-positive rate
  // beats coverage). Mechanics: balanced-paren walk from the matched call
  // opener (may cross lines — multi-line arg lists stay supported), then
  // inspect the remainder of the closing line: no `if` -> plain
  // construction, bind; `if ... else <elseRe>` -> both-arms, bind;
  // otherwise skip. Nested conditionals in the condition slot land on the
  // wrong `else` and skip = honest miss (AST track). An unbalanced walk
  // preserves the historical prefix-only behavior.
  const pyCondArmGuard = (m, elseRe) => {
    let i = m.index + m[0].length; // just past the opening paren
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth !== 0) return false; // unbalanced: keep historical behavior
    const nl = text.indexOf('\n', i);
    const rest = text.slice(i, nl === -1 ? text.length : nl);
    if (!/^\s*if\b/.test(rest)) return false; // plain construction
    const elseIdx = rest.indexOf(' else ');
    if (elseIdx === -1) return true; // conditional with no visible else arm: never guess
    const after = rest.slice(elseIdx + 6).replace(/^\s+/, '');
    return !elseRe.test(after); // bind only when the else arm is the same proven construction
  };
  // Loop 338: Python flavour of the trailing-chain adjudication —
  // `client = OpenAI(api_key=k).chat` binds the CHAT sub-resource, not the
  // client (probe-verified false attribution, same class as the JS/Ruby
  // holes). Python has no universal value-identity trailer (no `.freeze`),
  // so ANY member trailer after the constructor's balanced close drops the
  // binding — including `.with_options(...)` (an openai-specific client
  // copy; whitelisting a per-SDK method is provider knowledge, AST track —
  // regressing it from accidental-bound to honest skip is the safe
  // direction). A trailing conditional (` if cond else ...`) is not a
  // member trailer and stays with pyCondArmGuard. Multi-line argument
  // lists adjudicate at the true close (the walk crosses lines); an
  // unbalanced walk preserves historical behavior.
  const pyCtorTrailerOk = (m) => {
    let i = m.index + m[0].length; // just past the constructor's opening paren
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth !== 0) return true; // unbalanced: keep historical behavior
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    return text[i] !== '.'; // member trailer => derived object, drop
  };
  // Loop 338: JS constructor trailing-chain adjudication — the JS mirror of
  // the Ruby rbCtorTrailerOk verdict (Loop 337). All JS/TS binding matchers
  // stop at the constructor's opening paren; a same-statement member trailer
  // (`const sc = new Stripe(k).charges`) means the variable holds a DERIVED
  // resource, not the client — binding it is a FALSE ATTRIBUTION (probe-
  // verified across declaration / deferred / fallback / guarded-if /
  // this-field / globalThis holders). Ruling: walk the constructor call's
  // balanced parens (crossing lines — multi-line arg lists adjudicate at the
  // true close, unlike Ruby's per-line accept), then the next non-space
  // character must NOT start a member access (`.` / `?.`). TS non-null
  // postfix (`!`) is value-identity and is skipped before the check; `as`
  // casts, `;`, `,`, comments and end-of-line all accept. The walk is
  // quote-naive: a `)` inside a string argument can only end the walk early
  // and at worst drop a real binding — a miss, never a false positive (the
  // safe direction). An unbalanced walk preserves historical behavior.
  const jsCtorTrailerOk = (m) => {
    let i = m.index + m[0].length; // just past the constructor's opening paren
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth !== 0) return true; // unbalanced: keep historical behavior
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    while (text[i] === '!') i++; // TS non-null postfix: value-identity
    if (text[i] === '.') return false; // derived-object trailer: not the client
    if (text[i] === '?' && text[i + 1] === '.') return false; // optional-chain trailer
    return true;
  };
  for (const [name, b] of bindings) {
    const e = escapeRe(name);
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=\\s*(?:await\\s+)?(?:new\\s+)?${e}\\s*\\(`, 'g'))) {
      if (bindingProseGuard(m)) continue; // multi-line prose container (template/comment): never mint an instance
      if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
      instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
    }
    // Loop 349: chained assignment spelling of the same declaration proof —
    //   const sc = client = new Stripe(key);
    // JS assignment is an expression: `d = new Stripe(k)` evaluates to the
    // constructed client and the declaration binds the same value — BOTH
    // names hold the client (language semantics, not chain-shape guessing).
    // The `new` keyword is REQUIRED here (unlike the plain declaration
    // form): the inner target is a keyword-less assignment, so the same
    // licensing rule as the deferred family applies. Two targets only
    // (3+ targets structurally fail the match — the inner target must be
    // followed directly by `= new`; they stay an honest skip, AST track).
    // `=(?!=)` on both operators rejects comparison lookalikes
    // (`a == b == new X()` / `a = b == new X()` — a boolean, never a
    // client). No TS annotation slot on the inner target (annotated
    // chained targets are rare — honest skip). Same guard set as the
    // plain form: prose guard + ctor-trailer walk.
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
      if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance
      if (jsInlineProseGuard(m)) continue; // same-line comment/string lookalike: never mint
      if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
      instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      instances.set(m[2], { mod: b.mod, ctor: name, named: b.named });
    }
    // Loop 239: fallback-default construction on the declaration line — the
    // memoized-singleton idiom popularized by Prisma's Next.js hot-reload
    // recipe and widely copied for API clients:
    //   const stripe = globalThis._stripe ?? new Stripe(key);
    //   let client = cachedClient || new Stripe(key);
    // Same proof as the plain declaration form (a `const/let/var` declaration
    // whose RHS constructs from a proven import binding); the only difference
    // is a fallback operand before `??`/`||`. Semantics: the declared
    // variable is either the cached value or the fresh construction — in the
    // memoized idiom both arms are the same client, and a non-client cached
    // arm would never carry the provider chains this binding is joined
    // against. The fallback operand is restricted to a simple dotted
    // identifier chain (`cached`, `globalThis._stripe`) — call expressions
    // (`getCached() ?? new ...`) and anything with parens/commas are an
    // honest skip (never guess across expression structure). `&&` is
    // deliberately excluded: `a && new X()` leaves the variable falsy when
    // `a` is falsy — never a construction guarantee. Ternaries
    // (`cond ? new X() : null`) are likewise not bound — the else arm is
    // arbitrary (AST track). Multi-line prose containers (template literals /
    // block comments) are rejected by bindingProseGuard (Loop 296) — a
    // quoted declaration line never mints an instance. Same-line comment /
    // in-string lookalikes are rejected by the shared prose guard (probe-verified: without it, `// const c = x ?? new
    // Stripe(k)` minted a binding — a real false-positive path).
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=\\s*[A-Za-z_$][\\w$.]*\\s*(?:\\?\\?|\\|\\|)\\s*(?:await\\s+)?(?:new\\s+)?${e}\\s*\\(`, 'g'))) {
      if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
      if (jsInlineProseGuard(m)) continue;
      if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
      instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
    }
    // Loop 310: TERNARY-SPELLED fallback construction on the declaration
    // line — the pre-ES2020 verbose spelling of the Loop 239 memoized-
    // singleton idiom, still common in legacy serverless handlers:
    //   const stripe = global._s ? global._s : new Stripe(key);
    // Binding proof: the condition operand and the consequent are the SAME
    // simple dotted identifier chain, so `x ? x : new Stripe(k)` is exactly
    // equivalent to `x || new Stripe(k)` — the variable is either the cached
    // value or the fresh construction, the same guarantee Loop 239 already
    // accepts. Restrictions mirror Loop 239: the operand is a simple dotted
    // identifier chain only (call expressions like `getCached() ?
    // getCached() : new ...` are an honest skip — a call is not guaranteed
    // idempotent, probe l); a DIFFERENT consequent (`a ? b : new X()`) never
    // binds — the consequent is arbitrary and stays AST track (probe m).
    // `?.`/`??` never match (`\?(?![?.])`), and prose lookalikes are
    // rejected by bindingProseGuard + the same-line quote-parity guard
    // guards. The backreference `\2` enforces operand identity
    // structurally — no phantom path without a quoted line surviving both
    // guards (probes n/o lock the comment/template cases).
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=\\s*([A-Za-z_$][\\w$.]*)\\s*\\?(?![?.])\\s*\\2\\s*:\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
      if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
      if (jsInlineProseGuard(m)) continue;
      if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
      instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
    }
    // Loop 304: BOTH-ARMS ternary construction on the declaration line — the
    // test/live key idiom, ubiquitous in payment integrations:
    //   const client = isTest ? new Stripe(testKey) : new Stripe(liveKey);
    // Binding proof: whichever arm wins, the variable holds a construction
    // from the proven import binding — a strictly stronger guarantee than
    // the Loop 239 fallback form (`x ?? new Stripe(k)`), whose cached arm is
    // not even required to construct. Restrictions: the consequent's call
    // must close on the SAME line (balanced-paren walk; multi-line arg lists
    // are an honest skip, matching the plain-declaration rule), and the
    // alternate must itself start with `new <Binding>(` — a `: null` /
    // `: makeFake()` else arm leaves the variable unproven and stays AST
    // track (probe-verified silent). Nested ternaries in the alternate
    // (`: other ? new X() : null`) are structurally rejected by the same
    // start-anchor. The condition is arbitrary single-line text: `?.` and
    // `??` never match (`\?(?![?.])`), and a lookalike inside prose is
    // rejected by bindingProseGuard + the same-line quote-parity guard —
    // with BOTH arms required to construct from a proven binding, a phantom
    // needs a quoted line that survives both guards (none known; fixture
    // JT3 locks the template case).
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=[^?;\\n]*\\?(?![?.])\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
      if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
      if (jsInlineProseGuard(m)) continue;
      let i = m.index + m[0].length; // just past the consequent's opening paren
      let depth = 1;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '\n') break; // consequent must close on the same line — honest skip
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      if (depth !== 0) continue;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      if (text[i] !== ':') continue;
      i++;
      const nl = text.indexOf('\n', i);
      const rest = text.slice(i, nl === -1 ? text.length : nl);
      const altM = new RegExp(`^\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`).exec(rest);
      if (!altM) continue; // else arm must also construct — otherwise AST track
      // Loop 338: alternate-arm trailer adjudication — `t ? new X(a) : new
      // X(b).charges` leaves the variable a derived resource on the else
      // path; walk the alternate's parens (same-line, rest is one line) and
      // reject a member trailer. TS non-null postfix is value-identity.
      let j = altM[0].length;
      let d2 = 1;
      while (j < rest.length && d2 > 0) {
        if (rest[j] === '(') d2++;
        else if (rest[j] === ')') d2--;
        j++;
      }
      if (d2 !== 0) continue; // alternate must close on the same line — honest skip
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      while (rest[j] === '!') j++;
      if (rest[j] === '.' || (rest[j] === '?' && rest[j + 1] === '.')) continue; // derived-object trailer (Loop 338)
      instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
    }
    // JS deferred-assignment constructor binding (the lazy-init singleton
    // idiom, dominant in serverless handlers):
    //   let client;
    //   function init() { client = new Stripe(key); }
    // Same evidence as the declaration form — a line-anchored assignment whose
    // RHS is a `new Binding(...)` call on a proven import binding. The `new`
    // keyword is required here (unlike the declaration form): it is what
    // licenses the keyword-less statement as JS-only syntax, so Python/Ruby
    // bare assignments never collide (their forms are handled by their own
    // gated matchers above/below). Field targets (`this.client = ...`,
    // `obj.client = ...`) never bind — the identifier must sit at statement
    // start. Comparison operators (`==`) never match (`\s*=\s*new` rejects a
    // second `=`). Logical assignment spellings of the same idiom also bind
    // (Loop 198): `client ??= new Stripe(key)` / `client ||= new Stripe(key)`
    // are the canonical one-line lazy-init forms in serverless handlers —
    // identical evidence (statement-start identifier + `new` on a proven
    // binding). `&&=` is deliberately excluded: it only assigns when the
    // target is already truthy, which is never a lazy-init construction —
    // honest skip rather than a guess. Multi-line prose containers (template
    // literals / block comments) are rejected by bindingProseGuard (Loop
    // 296) — a quoted constructor line never mints an instance.
    if (!isPy && !isRb && !isGo && !isPhp) {
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
      // Loop 349: chained assignment in the DEFERRED position — the
      // keyword-less spelling of the declaration chained form above:
      //   let a, b;
      //   a = b = new Stripe(key);
      // Same expression semantics (the inner assignment evaluates to the
      // constructed client, the outer target binds the same value — both
      // names hold the client) and same licensing rule as the plain
      // deferred matcher: `new` on a proven binding is what licenses the
      // keyword-less statement. Line-anchored, so comment/string
      // lookalikes at line start are structurally rejected; two targets
      // only (3+ structurally fail — the inner target must be followed
      // directly by `= new`); `=(?!=)` rejects comparison lookalikes;
      // prose guard + ctor-trailer walk as usual.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        instances.set(m[2], { mod: b.mod, ctor: name, named: b.named });
      }
      // Loop 240: fallback-default construction in the DEFERRED position —
      // the Loop 239 memoized-singleton idiom without a declaration keyword:
      //   let client;
      //   function init(k) { client = globalThis._stripe ?? new Stripe(k); }
      // Same proof and same restrictions as the Loop 239 declaration form:
      // the fallback operand must be a simple dotted identifier chain
      // (call expressions / parens / commas are an honest skip), `&&` is
      // excluded (falsy arm is never a construction guarantee), ternaries
      // are not bound (AST track). `new` is required, matching the deferred
      // family's licensing rule for keyword-less statements. Line-anchored,
      // so comment/string lookalikes at line start are structurally
      // rejected the same way as the plain deferred matcher.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$.]*\\s*(?:\\?\\?|\\|\\|)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
      // Loop 234: inline positions for the SAME deferred-assignment proof —
      // the single-line function body and second-statement-on-a-line forms:
      //   function init(k) { client = new Stripe(k); }
      //   let x = 1; client = new Stripe(k);
      //   const boot = (k) => { client = new Stripe(k); };
      // This is the Loop 212 inline judgement (`{`/`;` statement-boundary
      // tokens + prose guard) ported from the `this.<field>` form to the
      // plain-variable form, with ONE extra structural gate the field form
      // did not need: after `{`, a bare `ident = ...` can also be a
      // DESTRUCTURING DEFAULT (`({ a = new Stripe(k) } = cfg)` — `a` may
      // take cfg.a, an unproven value), whereas `this.f =` can never appear
      // in an object/binding pattern. The gate: walk the constructor call's
      // balanced parens and require the next non-space character to be `;`
      // — a statement terminator. Pattern elements are followed by `,` or
      // `}`, never `;`, so destructuring defaults are structurally rejected;
      // a statement written without its optional semicolon is an honest
      // skip (miss, never a false positive — the safe direction). The paren
      // walk is quote-naive: a `)` inside a string argument can only end the
      // walk early and fail the `;` check — again only ever a miss.
      // Commented / in-string lookalikes are rejected by the same-line
      // prose guard (inline positions are not line-anchored evidence).
      for (const m of text.matchAll(new RegExp(`[{;][ \\t]*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (jsInlineProseGuard(m)) continue;
        let i = m.index + m[0].length; // just past the opening paren
        let depth = 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        if (text[i] !== ';') continue; // not a statement: destructuring default / no-semicolon — honest skip
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
      // Loop 241: fallback-default construction in the INLINE positions —
      // the Loop 239/240 memoized-singleton idiom inside a single-line body
      // or as a second `;`-separated statement:
      //   function init(k) { client = globalThis._stripe ?? new Stripe(k); }
      //   const boot = (k) => { client = cached || new Stripe(k); };
      //   let x = 1; client = cached ?? new Stripe(x);
      // Same proof and same restrictions as the Loop 239/240 fallback forms:
      // fallback operand limited to a simple dotted identifier chain (call
      // expressions / parens / commas are an honest skip), `&&` excluded
      // (falsy arm is never a construction guarantee), ternaries not bound
      // (AST track), `new` required (deferred family's licensing rule for
      // keyword-less statements). Because inline positions are not
      // line-anchored evidence, BOTH Loop 234 gates apply verbatim: the
      // same-line prose guard (commented / in-string lookalikes) and the
      // balanced-paren `;`-terminator walk (destructuring defaults —
      // `({ a = cached ?? new Stripe(k) } = cfg)` — are followed by `,`/`}`,
      // never `;`, so they are structurally rejected; a statement missing
      // its optional semicolon is a miss, never a false positive).
      for (const m of text.matchAll(new RegExp(`[{;][ \\t]*([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$.]*\\s*(?:\\?\\?|\\|\\|)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (jsInlineProseGuard(m)) continue;
        let i = m.index + m[0].length; // just past the opening paren
        let depth = 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        if (text[i] !== ';') continue; // not a statement: destructuring default / no-semicolon — honest skip
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
      // Loop 320: GUARDED-IF lazy-init construction — the classic pre-`??=`
      // memoization spelling, still dominant in Express/Lambda codebases:
      //   if (!client) client = new Stripe(key);
      //   if (client === null) client = new Stripe(key);
      // Semantics mirror the Loop 239 fallback family: the backreference
      // `\1` structurally forces the guard operand to be THE SAME name as
      // the assignment target, so after the statement the variable is
      // either its prior cached value or the fresh proven construction.
      // Restrictions: the guard must be a bare falsy check (`!x`) or a
      // null/undefined equality (`x == null`, `x === null`,
      // `x === undefined`) — compound conditions (`ready && !x`), Yoda
      // spellings and call expressions are an honest skip (AST track).
      // Only the SINGLE-LINE unbraced body needs this matcher: the braced
      // body puts the assignment behind a `{` (Loop 234 inline matcher)
      // and the multi-line body puts it at line start (deferred matcher),
      // both already bound. Line-anchored on `if`, so commented
      // lookalikes are structurally rejected; template/comment containers
      // are rejected by bindingProseGuard.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s*\\(\\s*!\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\1\\s*=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*===?\\s*(?:null|undefined)\\s*\\)\\s*\\1\\s*=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
      }
    }
    // Python instance vars from proven `from mod import Class` bindings:
    // `client = OpenAI(...)` — bare assignment at statement start (no JS
    // keyword). Only pyClass bindings qualify: the binding proof (a Python
    // from-import line) is what licenses the keyword-less form; module-object
    // bindings and JS imports never take this path.
    // An optional PEP 526 type annotation between the identifier and `=`
    // (`client: OpenAI = OpenAI(...)`, `sc: stripe.StripeClient = ...`) is
    // the dominant typed-Python idiom (mypy/FastAPI codebases) and carries
    // the exact same line-anchored proof — the annotation is a dotted name
    // with an optional subscript and never contains `=`, so dict-literal
    // entries (`key: OpenAI(),` — no `=`) and bare declarations
    // (`client: OpenAI` — no RHS) can never match.
    if (b.pyClass) {
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*${e}\\s*\\(`, 'gm'))) {
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // Loop 311: conditional RHS with a non-proven else arm never binds
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 348: chained assignment spelling of the same proof —
      //   sc = client = OpenAI(api_key=k)
      // Python chained-assignment semantics bind EVERY target to the same
      // RHS value — both names hold the constructed client (unambiguous,
      // not chain-shape guessing). Two targets only (3+ targets are rare
      // enough to stay an honest skip — AST track); PEP 526 annotations are
      // grammatically illegal in chained assignment, so no annotation slot.
      // Comparison lookalikes (`a == b == X(k)`) are structurally rejected:
      // an identifier must follow each `=`. Same guard set as the bare
      // form (prose guard because the second `=` breaks the line-anchor
      // uniqueness argument; cond-arm + ctor-trailer as usual).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\s*=\\s*${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // conditional RHS: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
        instances.set(m[2], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 315: `or`-fallback construction on the assignment line — the
      // Python spelling of the JS Loop 239 memoized-singleton idiom:
      //   client = cached or OpenAI(api_key=k)
      // Semantics: the bound name is either the cached value or the fresh
      // construction — the same guarantee Loop 239 already accepts for
      // `x ?? new Stripe(k)` / `x || new Stripe(k)`. Restrictions mirror
      // Loop 239 exactly: the fallback operand is a simple dotted identifier
      // chain only (call expressions — `get_cached() or OpenAI(k)` — are an
      // honest skip: a call is not guaranteed idempotent, probe f); `and` is
      // deliberately excluded (`flag and OpenAI(k)` leaves the name falsy
      // when the flag is falsy — never a construction guarantee, probe g).
      // The line anchor structurally rejects `#`-comment lookalikes, and
      // bindingProseGuard rejects docstring / triple-quoted lines (which
      // also start at column 0 — Loop 308 lesson, probe h). pyCondArmGuard
      // still applies: a trailing conditional with a non-proven else arm
      // never binds.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\s+or\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // Loop 311 ruling carries over
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 316: same-operand conditional fallback — the PEP 308 spelling of
      // the `or`-fallback idiom above (and the Python mirror of the JS
      // Loop 310 `x ? x : new X()` verdict):
      //   client = cached if cached else OpenAI(api_key=k)
      // A backreference structurally forces the value arm and the condition
      // to be the SAME simple dotted identifier chain — the bound name is
      // either the cached value or the fresh proven construction, exactly
      // the Loop 239/315 fallback guarantee. Restrictions mirror Loop 310:
      // the operand is a simple dotted chain only (call expressions are not
      // guaranteed idempotent = honest skip); a different value arm
      // (`other if cached else OpenAI(k)`) never matches the backreference
      // (AST track). The line anchor rejects `#`-comment lookalikes and
      // bindingProseGuard rejects docstring/triple-quoted lines; a trailing
      // nested conditional after the construction close is rejected by
      // pyCondArmGuard (never guess).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s+if\\s+\\2\\s+else\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 322: single-line GUARDED-IF lazy-init — the Python spelling of
      // the JS Loop 320 verdict:
      //   if not client: client = OpenAI(api_key=k)
      //   if client is None: client = OpenAI(api_key=k)
      // The backreference structurally forces the guard operand to be THE
      // SAME name as the assignment target, so after the statement the name
      // is either its prior cached value or the fresh proven construction —
      // the exact Loop 239/315/320 fallback guarantee. The guard is limited
      // to bare falsy (`not x`) or None equality (`is None` / `== None`);
      // compound conditions (`if ready and not x:`), different targets and
      // call expressions never match (honest skip / AST track). Line-anchored
      // on `if`, so `#`-comment lookalikes are structurally rejected;
      // docstring/triple-quoted containers are rejected by
      // bindingProseGuard. pyCondArmGuard still applies to the RHS.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+not\\s+([A-Za-z_]\\w*)\\s*:\\s*\\1\\s*=\\s*${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+([A-Za-z_]\\w*)\\s+(?:is|==)\\s+None\\s*:\\s*\\1\\s*=\\s*${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 231: PEP 572 walrus (assignment-expression) bindings —
      //   if client := OpenAI(api_key=k): client.chat.completions.create(...)
      //   while (sc := stripe.StripeClient(k)): ...
      // The walrus carries the exact same construction proof as the bare
      // assignment form (RHS is a direct call on a proven binding); only the
      // operator spelling differs. `:=` is a single token in Python — an
      // annotated assignment (`x: OpenAI = ...`) always has the annotation
      // between `:` and `=` and can never spell `:=`, so the two matchers
      // are structurally disjoint. The lookbehind rejects attribute targets
      // (`a.b := ...` is illegal Python anyway) and partial-name matches.
      // Because walrus positions are NOT line-anchored, a code-position
      // (prose) guard applies: a `#` comment opener or an unclosed quote in
      // the same-line prefix skips the match — commented or in-string
      // lookalikes must never mint a binding. Go's `:=` never collides:
      // pyClass/pyModule bindings only exist behind Python import proofs.
      // Honest limitation shared with the bare form: scope is file-level
      // (a walrus inside one function names a local), accepted as-is.
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])([A-Za-z_]\\w*)\\s*:=\\s*${e}\\s*\\(`, 'g'))) {
        if (pyWalrusProseGuard(m)) continue;
        if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // Loop 311
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: false });
      }
      // Loop 309: context-manager construction binding —
      //   with OpenAI(api_key=k) as client:  /  async with AsyncOpenAI(...) as client:
      // The openai-python v1 README itself spells client usage this way
      // (the client is a context manager), and httpx-style SDKs follow the
      // same idiom. The construction proof is identical to the bare
      // assignment form (a direct call on a proven from-import binding);
      // only the binding keyword differs (`as` instead of `=`). Rules:
      //   - line-anchored `with` / `async with` at statement start; a `#`
      //     before `with` structurally breaks the anchor (comment lookalikes
      //     never match), and bindingProseGuard rejects docstring/triple-
      //     quoted lines (which also start at column 0 — Loop 308 lesson)
      //   - earlier with-items may precede (`with open(f) as fh, OpenAI(...)`)
      //     via a conservative prefix that only crosses complete `as NAME,`
      //     items
      //   - the call must close on the SAME line (balanced-paren walk;
      //     multi-line arg lists are an honest skip, matching the
      //     plain-declaration rule) and be immediately followed by
      //     `as NAME` — a with-statement without `as` binds no name
      const pyWithBind = (re, ctorOf) => {
        for (const m of text.matchAll(re)) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
          let i = m.index + m[0].length; // just past the opening paren
          let depth = 1;
          while (i < text.length && depth > 0) {
            const ch = text[i];
            if (ch === '\n') break; // must close on the same line — honest skip
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            i++;
          }
          if (depth !== 0) continue;
          const nl = text.indexOf('\n', i);
          const rest = text.slice(i, nl === -1 ? text.length : nl);
          const asM = /^\s*as\s+([A-Za-z_]\w*)\s*[,:)]/.exec(rest);
          if (!asM) continue; // no `as NAME` -> no binding to mint
          instances.set(asM[1], { mod: b.mod, ctor: ctorOf(m), named: false });
        }
      };
      pyWithBind(
        new RegExp(`^[ \\t]*(?:async\\s+)?with\\s+(?:[^\\n#=]*?\\bas\\s+[A-Za-z_]\\w*\\s*,\\s*)?${e}\\s*\\(`, 'gm'),
        () => name
      );
    }
    // Python depth-1 module-attribute construction from a proven module
    // binding: `client = stripe.StripeClient(...)`, `s3 = boto3.client("s3")`.
    // The chain root here is the module object itself (a line-anchored import
    // proof), and exactly ONE attribute segment is allowed — deeper chains
    // (`sess = stripe.checkout.sessions.create(...)`) return API data, not
    // clients, and binding those would be chain-shape guessing (AST track).
    // Gated to Python files: the keyword-less bare assignment form is only
    // licensed by Python syntax. The same optional PEP 526 annotation slot
    // applies (`sc: stripe.StripeClient = stripe.StripeClient(...)`).
    if (isPy && b.pyModule) {
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // Loop 311: else arm must be the SAME depth-1 construction
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      // Loop 348: chained assignment spelling of the same depth-1 proof —
      //   sc = client = stripe.StripeClient(k)
      // Same semantics and guard set as the pyClass chained form above
      // (both targets bind to the same constructed value; two targets only;
      // comparison lookalikes structurally rejected); exactly ONE attribute
      // segment, matching the bare/walrus/with forms.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\s*=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // conditional RHS: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
        instances.set(m[2], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
      }
      // Loop 315: `or`-fallback spelling of the same depth-1 proof —
      //   sc = cached or stripe.StripeClient(k)
      // Same rules as the pyClass or-fallback form above (line anchor +
      // bindingProseGuard + simple dotted-chain operand + `and` excluded);
      // exactly ONE attribute segment, matching the bare/walrus/with forms.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\s+or\\s+${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // Loop 311 ruling carries over
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      // Loop 316: same-operand conditional fallback spelling of the depth-1
      // proof — `sc = cached if cached else stripe.StripeClient(k)`.
      // Same rules as the pyClass form above (backreference forces the value
      // arm ≡ condition; line anchor + bindingProseGuard + simple
      // dotted-chain operand); exactly ONE attribute segment.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?=\\s*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s+if\\s+\\2\\s+else\\s+${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
      }
      // Loop 322: single-line guarded-if spelling of the same depth-1 proof —
      //   if sc is None: sc = stripe.StripeClient(k)
      //   if not sc: sc = stripe.StripeClient(k)
      // Same rules as the pyClass guarded-if form above (backreference forces
      // guard operand ≡ assignment target; guard limited to bare falsy or
      // None equality; line anchor + bindingProseGuard + pyCondArmGuard);
      // exactly ONE attribute segment, matching the bare/walrus/with forms.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+not\\s+([A-Za-z_]\\w*)\\s*:\\s*\\1\\s*=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+([A-Za-z_]\\w*)\\s+(?:is|==)\\s+None\\s*:\\s*\\1\\s*=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // trailing nested conditional: never guess
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      // Loop 231: walrus spelling of the same depth-1 proof —
      //   while (sc := stripe.StripeClient(k)): ...
      // Exactly ONE attribute segment, same as the bare form (deeper chains
      // return API data, not clients — the `(?!\.)` lookahead after the call
      // opener is unnecessary because the segment regex already stops at the
      // first `(`; depth is enforced by the single `.` group). Same prose
      // guard as the pyClass walrus above. Python-file gated: Go's `:=`
      // short declaration spells identically, but pyModule bindings only
      // exist behind Python import proofs and this branch is isPy-gated.
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])([A-Za-z_]\\w*)\\s*:=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'g'))) {
        if (pyWalrusProseGuard(m)) continue;
        if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // Loop 311
        if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      // Loop 309: context-manager spelling of the same depth-1 proof —
      //   with stripe.StripeClient(k) as sc:  ->  sc binds
      // Same rules as the pyClass with-form above (line anchor +
      // bindingProseGuard + same-line balanced-paren close + `as NAME`);
      // exactly ONE attribute segment, matching the bare/walrus forms.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:async\\s+)?with\\s+(?:[^\\n#=]*?\\bas\\s+[A-Za-z_]\\w*\\s*,\\s*)?${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint an instance
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '\n') break; // must close on the same line — honest skip
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue;
        const nl = text.indexOf('\n', i);
        const rest = text.slice(i, nl === -1 ? text.length : nl);
        const asM = /^\s*as\s+([A-Za-z_]\w*)\s*[,:)]/.exec(rest);
        if (!asM) continue;
        instances.set(asM[1], { mod: b.mod, ctor: `${name}.${m[1]}`, named: false });
      }
    }
    // Go constructor instances from a proven package binding:
    //   client := openai.NewClient("key")
    //   c, err := plaid.NewClient(cfg)
    // Depth-1 only, and the called identifier must start with `New` — Go's
    // universal constructor convention. The package binding is the proof;
    // deeper chains or non-New calls returning values are API data, not
    // clients (AST track). Blank receivers (`_`) never bind. Gated to .go
    // files: `:=` short declaration is Go-only syntax.
    // Loop 356: the second name in the two-target form is ANY identifier,
    // not just `err` / `_` — real code spells the error `initErr` / `cerr`
    // / `e`, and parallel assignment (`client, e := pkg.New(k), error(nil)`)
    // is grammatically identical. In both readings Go semantics bind the
    // FIRST target to the first (or only) result of the first expression —
    // the constructor's client — so the first name carries the same proof
    // regardless of what the second is called. Constructors with the client
    // in a non-first result position do not exist in the scanned SDKs'
    // conventions (value first, error second); a ctor sitting in the SECOND
    // expression of a parallel assignment never matches (the RHS anchor sits
    // right after `:=`) = honest skip.
    if (isGo && b.goPkg) {
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)(?:\\s*,\\s*(?:[A-Za-z_]\\w*))?\\s*:=\\s*${e}\\.(New\\w*)\\s*\\(`, 'gm'))) {
        if (m[1] === '_') continue;
        // Loop 295: prose guard — a constructor line quoted inside a block
        // comment or a raw-string body (migration notes / usage docs, the
        // same carriers Loop 291 closed on the import-binding layer) must
        // never mint a phantom instance: a same-named local variable would
        // have its whole call surface falsely attributed to the SDK.
        // proseLineStarts already tracks Go containers (goMaskLine, Loop
        // 290) — this is the same one-line hookup the import matcher got.
        if (bindingProseGuard(m)) continue;
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
      // `var` declaration and bare `=` assignment forms of the same proof:
      //   var client = openai.NewClient(...)      (package-level singleton,
      //   client = openai.NewClient(...)           the dominant Go idiom for
      //                                            shared clients; the bare
      //   var ( sc = stripe.NewClient(...) )       form also covers var-block
      //                                            entries)
      // Same evidence as the `:=` form — a line-anchored assignment whose RHS
      // is a depth-1 `pkg.NewXxx(...)` call on a proven package binding. The
      // `:` of `:=` never matches here (`\s*=` rejects it), so the two
      // matchers are disjoint. Field targets (`obj.client = ...`) never bind
      // (identifier must sit at statement start). Loop 295: the raw-string /
      // block-comment lookalike exposure previously accepted as-is is now
      // closed — bindingProseGuard skips matches starting inside a Go prose
      // container (same guard as the `:=` form above).
      // Loop 357: the two-target spelling of the same proof —
      //   var client, err = openai.NewClient(k)     (package-level singleton)
      //   sc, scErr = stripe.NewClient(k)           (reassignment of declared names)
      //   var ( oc, ocErr = openai.NewClient(k) )   (var-block entry)
      // — the `var`/bare-`=` twin of the Loop 356 `:=` verdict: whether read
      // as a multi-value return or a parallel assignment, Go binds the FIRST
      // target to the first (or only) result of the first RHS expression —
      // the constructor's client — regardless of the second name. A ctor in
      // the SECOND expression of a parallel assignment never matches (the
      // RHS anchor sits right after `=`) = honest skip; a `_` first target
      // discards the client and never binds.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:var\\s+)?([A-Za-z_]\\w*)(?:\\s*,\\s*(?:[A-Za-z_]\\w*))?\\s*=\\s*${e}\\.(New\\w*)\\s*\\(`, 'gm'))) {
        if (m[1] === '_' || m[1] === 'var') continue;
        if (bindingProseGuard(m)) continue;
        instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
      }
    }
  }

  // Class-property constructor bindings (JS/TS): the service-class idiom
  //   class PaymentService {
  //     constructor(key) { this.stripe = new Stripe(key); }
  //     charge(a) { return this.stripe.charges.create(a); }
  //   }
  // The assignment is the same line-anchored proof as the deferred form
  // above — a statement-start `this.<field> = new <proven binding>(...)`
  // (logical lazy-init spellings `??=` / `||=` included, `&&=` excluded for
  // the Loop 198 reason). Chains rooted at `this.<field>.` then dispatch on
  // the FIELD segment against this map. Scope granularity is honest but
  // file-level, not class-level, so an ambiguity guard applies: if the same
  // field name is ALSO assigned anywhere in the file from a non-proven RHS
  // (`this.stripe = other`, `this.stripe &&= x`), the field is dropped —
  // never guess which class a `this.` chain belongs to. Multi-line prose
  // containers (template literals / block comments) are rejected by
  // bindingProseGuard (Loop 296) — a quoted field-assignment line never
  // mints a field. Gated off Python/Ruby/Go/PHP
  // (`this.` member assignment is JS-only among the scanned languages).
  const thisFields = new Map(); // fieldName -> { mod, ctor, named }
  const isTs = !!opts.isTs;
  // Loop 212: in addition to statement-start position, the assignment may sit
  // in a single-line method body (`constructor(k) { this.sc = new Stripe(k); }`)
  // or as a second statement on the same line (`this.n = 0; this.sc = new ...`).
  // Both `{` and `;` are unambiguous statement-boundary tokens in JS grammar:
  // an object literal cannot legally contain `this.<field> =` at entry
  // position, so a `{`/`;`-prefixed match is still an assignment statement.
  // Because this variant is NOT line-anchored, a code-position (prose) guard
  // applies to it: if the text on the same line BEFORE the match contains a
  // `//` or `/*` comment opener, or an unclosed quote (odd count of '/"/`),
  // the match is skipped — commented or in-string lookalikes must never mint
  // a binding. Prefer missing a binding over guessing.
  const inlineProseGuard = (m) => {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const prefix = text.slice(lineStart, m.index);
    if (/\/\/|\/\*/.test(prefix)) return true;
    for (const q of ["'", '"', '`']) {
      if ((prefix.split(q).length - 1) % 2 === 1) return true;
    }
    return false;
  };
  if (!isPy && !isRb && !isGo && !isPhp && bindings.size) {
    const provenLines = new Set();
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|([{;])[ \\t]*)this\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        thisFields.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      // Loop 361: hash-private field spelling (`this.#sc = new Stripe(k)`) —
      // the ES2022-private twin of the public this-field proof above. The
      // evidence is identical (a `this.`-target assignment whose RHS is
      // `new <proven binding>(...)`); only the field spelling differs, and
      // `#` is stored as part of the field key so minting, the ambiguity
      // guard and consumer dispatch all agree on one spelling. Guards
      // unchanged (bindingProseGuard + inline prose guard + jsCtorTrailerOk).
      for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|([{;])[ \\t]*)this\\.(#[A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        thisFields.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      // Loop 361: hash-private field INITIALIZER construction — the
      // declare-and-construct one-liner spelled with a private name:
      //   class Svc { #sc = new Stripe(key); }
      // Structural proof mirrors the Loop 232 modifier verdict: `#ident =`
      // at statement start is grammatically a class-field initializer and
      // nothing else — `#` is not legal statement syntax outside a class
      // body in any JS/TS grammar position, so plain variables and labeled
      // statements can never match. Unlike Loop 232 this needs no modifier
      // and no TS gate (the `#` itself is the class-body proof, valid in
      // plain .js). An optional TS type annotation between the name and `=`
      // is accepted (same grammar slot as the Loop 232 matcher).
      // Loop 367: extended symmetrically to inline (`{`/`;`-prefixed)
      // positions — a single-line class body (`class Svc { #sc = new
      // Stripe(k); use() {...} }`) spells the SAME proven initializer
      // inline, which the statement-start anchor could not see
      // (probe-loop367 pa/pe/pd: proven inline initializers + consumer
      // chains were honest misses). `#ident =` after `{`/`;` is still
      // grammatically a class-field initializer and nothing else (the
      // Loop 361 structural proof does not depend on the anchor — `#` is
      // not legal in any other statement position). Inline mints take the
      // inlineProseGuard (a `//`/`/*` opener or unclosed quote earlier on
      // the line rejects the match), mirroring the this-field matcher
      // above. The Loop 365/366 ambiguity guard is already inline-aware,
      // so a same-named non-proven inline initializer in another class
      // still drops the field (file-level scope, never guess).
      for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|([{;])[ \\t]*)(#[A-Za-z_$][\\w$]*)\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=\\s*new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        thisFields.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      // Loop 359: chained assignment with a this-field target — the JS
      // composition of Loop 349 (JS assignment is an expression: every
      // target in a chain binds the same constructed value — language
      // semantics, not chain-shape guessing) and the this-field proof
      // above, mirroring the Python self-field verdict (Loop 358) and the
      // PHP field-target verdict (Loop 352):
      //   this.sc = client = new Stripe(key);      (field-first)
      //   client = this.sc = new Stripe(key);      (var-first)
      //   this.sc = this.alias = new Stripe(key);  (field-to-field)
      // Two targets only (3+ structurally fail — `new` must directly
      // follow the second `=`; honest skip, AST track); `=(?!=)` on both
      // operators rejects comparison lookalikes; `new` is REQUIRED (the
      // keyword-less inner/outer targets follow the deferred-family
      // licensing rule, Loop 349). Line-anchored at statement start —
      // inline `{`/`;` positions stay an honest skip (the Loop 358
      // anchoring choice carried over). Guards unchanged: bindingProseGuard
      // + jsCtorTrailerOk. Field proofs join provenLines at the match
      // start; the ambiguity guard's line-anchored alternative matches the
      // same index, so it never vetoes its own evidence, and mid-line
      // field writes (var-first second position / field-to-field second
      // field) are not anchor-visible to the guard at all.
      // Loop 362: the field name class admits an optional `#` — the
      // hash-private twin of this chained family (Loop 361 ruling: `#` is
      // only a field spelling, the `new <proven binding>(...)` evidence is
      // identical; the `#` is stored in the field key so minting, the
      // ambiguity guard and consumer dispatch agree on one spelling).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*this\\.(#?[A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
        thisFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        instances.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*this\\.(#?[A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
        instances.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        thisFields.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*this\\.(#?[A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*this\\.(#?[A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
        thisFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        thisFields.set(m[2], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      // Loop 321: GUARDED-IF lazy-init on a this-field — the field spelling
      // of the Loop 320 single-line unbraced guarded-if verdict:
      //   if (!this.sc) this.sc = new Stripe(key);
      //   if (this.sc === null) this.sc = new Stripe(key);
      // The backreference `\1` structurally forces the guard operand to be
      // THE SAME field as the assignment target, so after the statement the
      // field is either its prior cached value or the fresh proven
      // construction — the exact Loop 239/320 fallback guarantee. Compound
      // conditions, different targets, Yoda spellings and call expressions
      // never match (honest skip / AST track). Line-anchored on `if`, so
      // commented lookalikes are structurally rejected; template/comment
      // containers are rejected by bindingProseGuard. The assignment sits
      // after `)` — not a statement-boundary token — so the ambiguity guard
      // below cannot see (and cannot drop) its own proof; provenLines is
      // recorded anyway for symmetry with the other minting positions.
      // Loop 363: `#?` admits ES2022 hash-private fields in BOTH guarded-if
      // spellings — `#` is just the field spelling (Loop 361 ruling
      // verbatim); the guarded-if proof (guard field === assigned field via
      // backreference, RHS `new <proven binding>(...)`) is unchanged. The
      // backreference carries the `#`, so a hash guard on a non-hash
      // assignment (or vice versa) structurally never matches. The `#` is
      // stored in the field key — minting / ambiguity guard / consumer
      // dispatch already share the spelling since Loop 361.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s*\\(\\s*!\\s*this\\.(#?[A-Za-z_$][\\w$]*)\\s*\\)\\s*this\\.\\1\\s*=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        thisFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s*\\(\\s*this\\.(#?[A-Za-z_$][\\w$]*)\\s*===?\\s*(?:null|undefined)\\s*\\)\\s*this\\.\\1\\s*=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        thisFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        provenLines.add(m.index);
      }
      // Loop 232: class property INITIALIZER construction — the declare-and-
      // construct one-liner that modern TS codebases prefer over a ctor body:
      //   class Svc {
      //     private stripe = new Stripe(key);
      //     private readonly sc: Stripe = new Stripe(key);
      //   }
      // Same evidence as the this-field form (an assignment whose RHS is
      // `new <proven binding>(...)`), only the target spelling differs. At
      // least one modifier (public/private/protected/readonly/static/
      // override) is REQUIRED: modifier-prefixed `ident = ...` at statement
      // start is grammatically a class-field initializer and nothing else
      // (it is not legal statement syntax outside a class body), so plain
      // variables and labeled statements can never match. Modifier-less
      // field initializers (`stripe = new Stripe(k)` in a class body) are
      // honestly not bound — the same line outside a class is a plain
      // assignment (already covered by the deferred-assignment matcher as a
      // VARIABLE), and telling the two apart is class-span tracking (AST
      // track). An optional type annotation between the name and `=` is
      // accepted (dotted name + optional generic, never contains `=` — same
      // grammar as the const-declaration slot). Gated to .ts/.tsx: the
      // modifier keywords are TS-only syntax, in .js they are prose. The
      // field joins thisFields, so the consumer-side `this.` dispatch and
      // the ambiguity guard below apply unchanged.
      if (isTs) {
        for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:(?:public|private|protected|readonly|static|override)\\s+)+([A-Za-z_$][\\w$]*)[?!]?\\s*(?::\\s*[A-Za-z_$][\\w$.]*(?:<[^>=\\n]*>)?\\s*)?=\\s*new\\s+${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // multi-line prose container: never mint an instance/field
          if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          thisFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
          provenLines.add(m.index);
        }
      }
    }
    if (thisFields.size) {
      // Ambiguity guard: any other assignment to a collected field name
      // (including `&&=`, plain `=`, but never `==` comparisons) unbinds it.
      // Extended symmetrically to inline (`{`/`;`-prefixed) positions —
      // deliberately WITHOUT the prose guard: a lookalike here can only DROP
      // a field (miss, never a false positive), which is the safe direction.
      for (const m of text.matchAll(/(?:^[ \t]*|[{;][ \t]*)this\.(#?[A-Za-z_$][\w$]*)\s*(?:\?\?|\|\||&&)?=(?!=)/gm)) {
        if (!thisFields.has(m[1]) || provenLines.has(m.index)) continue;
        // Loop 325: null-init whitelist — the JS mirror of the Loop 324
        // Python `self.x = None` verdict. A plain `this.x = null` (or
        // `= undefined`) in a constructor is the canonical placeholder for
        // a lazily constructed client: it means "not yet constructed",
        // never "a different construction", so it carries no ambiguity
        // about what the field holds once built and must not drop a proven
        // guarded-if binding. Strictly limited: plain `=` only (compound
        // `??=`/`||=`/`&&=` never whitelisted — a compound op implies a
        // prior value of unknown origin) and the RHS up to the end of the
        // statement/line must be exactly the bare null/undefined literal
        // (optional `;`, optional line comment). Any other RHS
        // (conditionals, calls, names) still drops via the guard — the
        // safe direction is unchanged.
        if (!/(?:\?\?|\|\||&&)=$/.test(m[0])) {
          const nl = text.indexOf('\n', m.index + m[0].length);
          const rest = text.slice(m.index + m[0].length, nl === -1 ? undefined : nl);
          if (/^[ \t]*(?:null|undefined)[ \t]*;?[ \t]*(?:\/\/.*)?$/.test(rest)) continue;
        }
        thisFields.delete(m[1]);
      }
      // Loop 232: symmetric guard for field-initializer targets — another
      // modifier-prefixed initializer of the same name from a NON-proven RHS
      // (`private stripe = other;`) unbinds it. Scope is file-level, not
      // class-level, so a reused field name across classes must never guess.
      if (isTs) {
        for (const m of text.matchAll(/^[ \t]*(?:(?:public|private|protected|readonly|static|override)\s+)+([A-Za-z_$][\w$]*)[?!]?\s*(?::\s*[A-Za-z_$][\w$.]*(?:<[^>=\n]*>)?\s*)?=(?!=)/gm)) {
          if (thisFields.has(m[1]) && !provenLines.has(m.index)) thisFields.delete(m[1]);
        }
      }
      // Loop 365: symmetric guard for HASH-PRIVATE initializer targets — the
      // `#` twin of the Loop 232 guard above. The Loop 361 initializer
      // matcher mints from `#field = new <proven binding>(...)` at statement
      // start, but a same-named `#field = <non-proven RHS>` initializer in
      // ANOTHER class of the same file previously went unguarded (the Loop
      // 232 guard requires a TS modifier and is TS-gated; the this-field
      // guard only sees `this.#field =` writes) — probe-verified FALSE
      // POSITIVE (loop/evidence/probe-loop365 pa: a legacy-gateway field in
      // a second class emitted a provider chain). `#ident =` at statement
      // start is grammatically a class-field initializer and nothing else
      // (Loop 361 structural proof), so this guard can never see plain
      // variables. File-level scope: never guess which class a `this.#f`
      // chain belongs to. The Loop 325 null-placeholder whitelist applies
      // verbatim (`#gate = null;` means "not yet constructed", it must not
      // drop a proven guarded-if binding — probe pd). No TS gate: `#` is
      // valid in plain .js (Loop 361).
      // Loop 366: extended symmetrically to inline (`{`/`;`-prefixed)
      // positions — a single-line class body (`class B { #f = other(); }`)
      // spells the SAME non-proven initializer inline, which the
      // statement-start anchor cannot see (probe-loop366 pc: a same-named
      // legacy field in a second single-line class emitted a provider
      // chain = FALSE POSITIVE). Inline positions deliberately skip the
      // prose guard, mirroring the this-field guard above: a lookalike
      // here can only DROP a field (miss, never a false positive — the
      // safe direction). Minting stays statement-start-only (Loop 361
      // honest skip unchanged); this guard is drop-only.
      for (const m of text.matchAll(/(?:^[ \t]*|[{;][ \t]*)(#[A-Za-z_$][\w$]*)[?!]?\s*(?::\s*[A-Za-z_$][\w$.]*(?:<[^>=\n]*>)?\s*)?(?:\?\?|\|\||&&)?=(?!=)/gm)) {
        if (!thisFields.has(m[1]) || provenLines.has(m.index)) continue;
        if (!/(?:\?\?|\|\||&&)=$/.test(m[0])) {
          const nl = text.indexOf('\n', m.index + m[0].length);
          const rest = text.slice(m.index + m[0].length, nl === -1 ? undefined : nl);
          // Loop 366: in inline position the statement terminator is `;`,
          // not end-of-line — `#gate = null; isCold() {...}` in a
          // single-line class body is still exactly the bare placeholder
          // literal (the RHS provably ends at the `;`), so the whitelist
          // accepts a `;`-terminated literal with trailing code as well as
          // the original end-of-line form. Any non-literal RHS still drops.
          if (/^[ \t]*(?:null|undefined)[ \t]*(?:;|$|\/\/)/.test(rest)) continue;
        }
        thisFields.delete(m[1]);
      }
    }
  }

  // Loop 318: global-cache constructor bindings (JS/TS) — the hot-reload
  // memoization idiom popularized by Prisma's Next.js recipe, spelled
  // directly on the global object instead of a declared variable:
  //   globalThis._stripe ??= new Stripe(key);
  //   global._sc = new Stripe(key);
  //   ...later: globalThis._stripe.charges.create(...)
  // Loop 239 already binds the DECLARED-VARIABLE spelling of this idiom
  // (`const s = globalThis._s ?? new Stripe(k)`), but the direct spelling —
  // assign once to `globalThis.<field>`, then chain on `globalThis.<field>.`
  // everywhere — never bound on either end (probe-verified silent). The
  // proof mirrors the this-field form exactly: a line-anchored assignment
  // whose RHS is `new <proven binding>(...)`, with the lazy-init logical
  // spellings `??=` / `||=` included and `&&=` excluded (only assigns when
  // the target is already truthy — never a construction guarantee, Loop 198
  // reason). `globalThis` and `global` are the SAME namespace in Node
  // (`global.x === globalThis.x`), so fields are keyed by name alone and
  // the ambiguity guard spans both spellings: any other assignment to the
  // same field name from a non-proven RHS drops the field — never guess
  // which value a shared global holds. Multi-line prose containers are
  // rejected by bindingProseGuard; commented lookalikes are structurally
  // rejected by the `^[ \t]*` line anchor. Gated off Python/Ruby/Go/PHP
  // (`globalThis` member assignment is JS-only among the scanned languages).
  const jsGlobalFields = new Map(); // fieldName -> { mod, ctor, named }
  if (!isPy && !isRb && !isGo && !isPhp && bindings.size) {
    const gProvenIdx = new Set();
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:globalThis|global)\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint a field
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        jsGlobalFields.set(m[1], { mod: b.mod, ctor: name, named: b.named });
        gProvenIdx.add(m.index);
      }
    }
    if (jsGlobalFields.size) {
      // Ambiguity guard: any other assignment to a collected global field
      // (including `&&=`, plain `=`, never `==` comparisons), in EITHER
      // spelling and in line-anchored OR inline (`{`/`;`) position, unbinds
      // it. Inline positions deliberately skip the prose guard: a lookalike
      // can only DROP a field (miss, never a false positive — the safe
      // direction), mirroring the this-field guard.
      for (const m of text.matchAll(/(?:^[ \t]*|[{;][ \t]*)(?:globalThis|global)\.([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\||&&)?=(?!=)/gm)) {
        if (jsGlobalFields.has(m[1]) && !gProvenIdx.has(m.index)) jsGlobalFields.delete(m[1]);
      }
    }
  }

  // Loop 368: namespace-object property constructor bindings (JS/TS) — the
  // named-container twin of the this-field (Loop 203/212) and global-cache
  // (Loop 318) proofs. The module-level singleton registry idiom:
  //   const registry = {};
  //   registry.sc = new Stripe(key);
  //   ...later: registry.sc.charges.create(...)
  // The proof is identical — a statement-start (or `{`/`;`-inline, with the
  // prose guard) assignment whose RHS is `new <proven binding>(...)`; only
  // the target spelling differs (a plain named object root instead of
  // this/globalThis). Lazy-init `??=`/`||=` included, `&&=` excluded (Loop
  // 198 reason). Fields are keyed by `root.field` so two containers with a
  // same-named field never collide. Reserved roots (this/globalThis/global/
  // window/self/module/exports/super) are excluded — each is either covered
  // by its own pass or unsafe to attribute; roots that are themselves proven
  // ctor binding names are excluded too (a property written onto an SDK
  // class object is not a container field). Two guards (probe-loop368):
  // (1) any other assignment to the same `root.field` from a non-proven RHS
  //     drops the field — Loop 325 null-placeholder whitelist applies
  //     verbatim (`registry.sc = null;` means "not yet constructed");
  // (2) any rebinding of the ROOT identifier itself drops every field under
  //     it, unless the RHS is the canonical empty container (`{}` /
  //     `Object.create(null)`) a declaration uses — never guess what a
  //     replaced container holds. Compound ops on the root always drop.
  // Both guards deliberately skip the prose guard: a lookalike can only DROP
  // a field (miss, never a false positive — the safe direction). Gated off
  // Python/Ruby/Go/PHP (`ident.field =` member assignment dispatch here is
  // JS-family-only among the scanned languages).
  const jsNsObjFields = new Map(); // `root.field` -> { mod, ctor, named, root, field }
  if (!isPy && !isRb && !isGo && !isPhp && bindings.size) {
    const NSOBJ_RESERVED = new Set(['this', 'globalThis', 'global', 'window', 'self', 'module', 'exports', 'super']);
    const nsProvenIdx = new Set();
    const nsRootProvenIdx = new Set(); // declaration indices of literal-initializer mints (Loop 369)
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|([{;])[ \\t]*)([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)?=\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'gm'))) {
        if (NSOBJ_RESERVED.has(m[2]) || bindings.has(m[2])) continue;
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint a field
        if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
        if (!jsCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
        jsNsObjFields.set(`${m[2]}.${m[3]}`, { mod: b.mod, ctor: name, named: b.named, root: m[2], field: m[3] });
        nsProvenIdx.add(m.index);
      }
    }
    // Loop 369: object-literal property INITIALIZER spelling of the same
    // proof — the container is declared with the client already inside:
    //   const box = { sc: new Stripe(key) };
    //   ...later: box.sc.charges.create(...)
    // Same evidence (`new <proven binding>(...)`), same key (`root.field`),
    // same guards; only the mint position differs (a property inside the
    // declaration's literal instead of a later assignment statement).
    // Rules (probe-loop369): the declaration must be a statement-start
    // `const/let/var <root> = {`; the literal extent is found by a balanced
    // brace walk in which nested-brace content (depth > 1) is blanked, so
    // only DEPTH-1 properties can mint (a client inside a nested literal is
    // not addressable as `root.field` — never guess). The property key must
    // be a plain identifier immediately preceded by `{` or `,` (rejects
    // ternary lookalikes like `pick: flag ? sc : new Stripe(k)` where `sc :`
    // is a ternary arm, not a key). The walk is quote-naive: a brace inside
    // a string can only blank or truncate — a miss, never a false positive
    // (the safe direction). The declaration's own index is recorded so the
    // root-rebinding guard below does not treat the declaration itself as a
    // container replacement (its RHS is the mint, not the canonical empty
    // container). Prose containers are rejected by bindingProseGuard at both
    // the declaration and the property line.
    // Loop 370: value-identity wrappers — `Object.freeze(...)`/`Object.seal(...)`
    // return the SAME object, so a frozen/sealed literal declaration
    // (`const services = Object.freeze({ sc: new Stripe(k) })`, the
    // defensive singleton spelling, JS twin of Ruby's `.freeze` ruling in
    // Loop 337) carries the identical proof. Arbitrary wrapper calls are
    // rejected structurally (unknown return value — never guess).
    for (const dm of text.matchAll(/(?:^[ \t]*|[{;][ \t]*)(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.(?:freeze|seal)\(\s*)?\{/gm)) {
      const root = dm[1];
      if (NSOBJ_RESERVED.has(root) || bindings.has(root)) continue;
      if (bindingProseGuard(dm)) continue;
      const open = dm.index + dm[0].length - 1; // position of the `{`
      let depth = 0;
      let close = -1;
      const masked = [];
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { close = i; break; }
        }
        if (i > open) masked.push(depth > 1 ? (ch === '\n' ? '\n' : ' ') : ch);
      }
      if (close === -1) continue; // unbalanced: never guess the literal extent
      const body = masked.join('');
      for (const [name, b] of bindings) {
        const e = escapeRe(name);
        for (const pm of body.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*(?:await\\s+)?new\\s+${e}\\s*\\(`, 'g'))) {
          const abs = open + 1 + pm.index;
          // Key position proof: the previous non-space char must be `{` or
          // `,` (start of a property), never a ternary `?` arm or similar.
          let j = abs - 1;
          while (j >= open && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j--;
          if (text[j] !== '{' && text[j] !== ',') continue;
          const shim = { index: abs, 0: pm[0] };
          if (bindingProseGuard(shim)) continue;
          if (!jsCtorTrailerOk(shim)) continue; // derived-object trailer: not the client
          jsNsObjFields.set(`${root}.${pm[1]}`, { mod: b.mod, ctor: name, named: b.named, root, field: pm[1] });
          nsProvenIdx.add(abs);
          nsRootProvenIdx.add(dm.index);
        }
      }
    }
    if (jsNsObjFields.size) {
      // Guard 1: any other assignment to a collected `root.field` from a
      // non-proven RHS unbinds it (null-placeholder whitelist, Loop 325).
      for (const m of text.matchAll(/(?:^[ \t]*|[{;][ \t]*)([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\||&&)?=(?!=)/gm)) {
        const key = `${m[1]}.${m[2]}`;
        if (!jsNsObjFields.has(key) || nsProvenIdx.has(m.index)) continue;
        if (!/(?:\?\?|\|\||&&)=$/.test(m[0])) {
          const nl = text.indexOf('\n', m.index + m[0].length);
          const rest = text.slice(m.index + m[0].length, nl === -1 ? undefined : nl);
          if (/^[ \t]*(?:null|undefined)[ \t]*(?:;|$|\/\/)/.test(rest)) continue;
        }
        jsNsObjFields.delete(key);
      }
      // Guard 2: root identifier rebinding — any assignment to the bare root
      // drops all its fields unless it is a plain `=` of the canonical empty
      // container. Compound ops always drop (prior value of unknown origin).
      const nsRootsSet = new Set([...jsNsObjFields.values()].map((v) => v.root));
      for (const r of nsRootsSet) {
        const re = new RegExp(`(?:^[ \\t]*|[{;][ \\t]*)(?:(?:const|let|var)[ \\t]+)?${escapeRe(r)}\\s*(\\?\\?|\\|\\||&&)?=(?!=)([^\\n]*)`, 'gm');
        for (const m of text.matchAll(re)) {
          // Loop 369: a declaration whose literal itself minted a field is
          // the proof, not a container replacement — skip it.
          if (nsRootProvenIdx.has(m.index)) continue;
          // The RHS statement ends at the first `;` (a single-line
          // `const depot = {}; depot.core = new Stripe(k);` declaration is
          // still the canonical empty container — the tail after `;` is a
          // separate statement, not part of the RHS).
          if (!m[1] && /^\s*(?:\{\s*\}|Object\.create\(\s*null\s*\))\s*(?:;|$|\/\/)/.test(m[2])) continue;
          for (const [k, v] of [...jsNsObjFields]) {
            if (v.root === r) jsNsObjFields.delete(k);
          }
          break;
        }
      }
      // Loop 371: destructured pull of a proven container field into a local
      // binding — the block-scoped twin of the container consumption chain:
      //   const services = { sc: new Stripe(key) };
      //   const { sc } = services;         // or: const { sc: pay } = services;
      //   ...later: sc.charges.create(...)
      // ES destructuring copies the property VALUE (the proven client object
      // itself), so the local carries the same construction proof as the
      // `root.field` chain (value identity, the same reasoning family as the
      // freeze/seal ruling in Loop 370). Only simple `field` / `field: local`
      // entries mint — defaults, rest and nested patterns are structurally
      // rejected (never guess). The pass runs AFTER both guards above, so a
      // field dropped by either guard can never mint a local. Any other
      // assignment to the bare local anywhere in the file drops it (stricter
      // than plain instance locals — the destructured name is one hop from
      // the proof, so the safe direction wins; the destructuring statement
      // itself can never match the guard: the local sits inside `{...}`).
      {
        const nsDestructured = new Map(); // local -> field info
        for (const m of text.matchAll(/(?:^[ \t]*|([{;])[ \t]*)(?:const|let|var)[ \t]*\{([^{}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|$)/gm)) {
          const root = m[3];
          if (![...jsNsObjFields.values()].some((v) => v.root === root)) continue;
          if (bindingProseGuard(m)) continue; // multi-line prose container: never mint
          if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
          for (const entry of m[2].split(',')) {
            const em = entry.match(/^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?$/);
            if (!em) continue; // default / rest / nested pattern: never guess
            const nf = jsNsObjFields.get(`${root}.${em[1]}`);
            if (!nf) continue;
            const local = em[2] || em[1];
            if (bindings.has(local)) continue; // never shadow a ctor binding name
            nsDestructured.set(local, nf);
          }
        }
        for (const [local, nf] of nsDestructured) {
          const guardRe = new RegExp(`(?:^[ \\t]*|[{;][ \\t]*)(?:(?:const|let|var)[ \\t]+)?${escapeRe(local)}\\s*(?:\\?\\?|\\|\\||&&)?=(?!=)`, 'gm');
          if ([...text.matchAll(guardRe)].length) continue; // any reassignment: drop
          instances.set(local, { mod: nf.mod, ctor: nf.ctor, named: nf.named });
        }
      }
      // Loop 372: plain member alias off a proven container field — the
      // declaration twin of the Loop 371 destructured pull:
      //   const services = { sc: new Stripe(key) };
      //   const sc = services.sc;        // or renamed: const pay = services.sc;
      //   ...later: sc.charges.create(...)
      // The RHS is a PURE member expression of exactly `root.field` — the
      // statement ends right after the field (`;` or line end), so the
      // assigned value cannot be API data (data only ever comes back from a
      // call) and cannot be a derived sub-object (no deeper segments — deep
      // trailing chains like `services.sc.charges` stay on the sub-client /
      // AST track, never guess). The local therefore holds the same proven
      // client object (value identity, the same reasoning family as the
      // Loop 370 freeze/seal and Loop 371 destructuring rulings). The same
      // extra-strict guard as Loop 371 applies: ANY other assignment to the
      // local anywhere in the file drops it (the local is one hop from the
      // proof — safe direction); unlike the destructuring form, the alias
      // declaration itself DOES match the guard shape, so its own index is
      // exempted. The pass runs AFTER both container guards, so a field
      // dropped by either guard can never mint a local.
      {
        const nsFieldAliases = new Map(); // local -> { nf, declIdx }
        for (const m of text.matchAll(/(?:^[ \t]*|([{;])[ \t]*)(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:;|$)/gm)) {
          const nf = jsNsObjFields.get(`${m[3]}.${m[4]}`);
          if (!nf) continue;
          if (bindingProseGuard(m)) continue; // multi-line prose container: never mint
          if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
          const local = m[2];
          if (bindings.has(local)) continue; // never shadow a ctor binding name
          if (nsFieldAliases.has(local)) { nsFieldAliases.delete(local); continue; } // two declarations of one name: ambiguous, drop
          nsFieldAliases.set(local, { nf, declIdx: m.index });
        }
        for (const [local, a] of nsFieldAliases) {
          const guardRe = new RegExp(`(?:^[ \\t]*|[{;][ \\t]*)(?:(?:const|let|var)[ \\t]+)?${escapeRe(local)}\\s*(?:\\?\\?|\\|\\||&&)?=(?!=)`, 'gm');
          let rebound = false;
          for (const g of text.matchAll(guardRe)) {
            // Both the alias matcher and this guard anchor at the same
            // statement-start position, so the declaration's own guard hit
            // lands exactly at declIdx — exempt it, drop on anything else.
            if (g.index === a.declIdx) continue;
            rebound = true;
            break;
          }
          if (rebound) continue; // any other assignment: drop
          if (!instances.has(local)) {
            instances.set(local, { mod: a.nf.mod, ctor: a.nf.ctor, named: a.nf.named });
            jsAliasProvenIdx.add(a.declIdx); // Loop 373: exempt the alias declaration from the plain-local rebinding guard
          }
        }
      }
    }
  }

  // Loop 209: Python instance-attribute constructor bindings — the Python
  // mirror of the JS this-field proof (Loop 203) and the PHP $this-> proof
  // (Loop 204). The service-class idiom:
  //   class AIService:
  //       def __init__(self, key):
  //           self.client = OpenAI(api_key=key)
  //           self.sc = stripe.StripeClient(key)
  //       def ask(self, q):
  //           return self.client.chat.completions.create(...)
  // Two proven RHS forms, exactly the ones the variable-form Python passes
  // accept: a pyClass binding called directly (`OpenAI(...)`, from-import
  // proof) and a depth-1 module-attribute construction on a pyModule binding
  // (`stripe.StripeClient(...)`, import proof). An optional PEP 526
  // annotation slot between the field and `=` is accepted (same grammar as
  // the variable form — the annotation never contains `=`). Scope is honest
  // but file-level, not class-level, so the same ambiguity guard as the
  // JS/PHP mirrors applies: any other assignment to a collected field name
  // anywhere in the file (plain or augmented `=`, never `==` comparisons)
  // drops the field — never guess which class a `self.` chain belongs to.
  // named:false always — Python sites must never emit controller-call
  // companions (controller packs anchor JS `new Ctor(...)` rewrites).
  // Gated to .py files: `self.` attribute assignment at statement start is
  // only licensed by Python syntax. The docstring-lookalike exposure
  // previously accepted as-is is now closed: bindingProseGuard (Loop 297)
  // rejects matches starting inside a multi-line prose container
  // (docstring / triple-quoted constant), so a quoted migration-note line
  // never mints a phantom field.
  const pySelfFields = new Map(); // fieldName -> { mod, ctor, named }
  if (isPy && bindings.size) {
    const selfProvenIdx = new Set();
    const ANN = `(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?`;
    // Loop 213: the Python mirror of the JS inline extension (Loop 212).
    // Besides the statement-start position, the assignment may sit in a
    // single-line compound-statement suite (`def __init__(self, k): self.c =
    // OpenAI(k)`) or as a second `;`-separated statement. Accepted inline
    // boundaries are structurally unambiguous: a suite colon can only follow
    // a `)` (def/if/while/for headers, optionally with a `->` return
    // annotation) or the bare keywords else/try/finally — an annotated
    // assignment lookalike (`hint: self.ac = OpenAI(k)`, where `self.ac` is
    // the ANNOTATION of target `hint`) has an identifier before the colon
    // and never matches. Because inline positions are not line-anchored, a
    // code-position (prose) guard applies to them: a `#` comment opener or
    // an unclosed quote (odd count of ' / ") in the same-line prefix skips
    // the match — commented or in-string lookalikes must never mint a
    // binding. Prefer missing a binding over guessing.
    const PYB = `((?:\\)\\s*(?:->[^:\\n]+)?|\\b(?:else|try|finally))\\s*:|;)[ \\t]*`;
    const pyProseGuard = (m) => {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const prefix = text.slice(lineStart, m.index);
      if (prefix.includes('#')) return true;
      for (const q of ["'", '"']) {
        if ((prefix.split(q).length - 1) % 2 === 1) return true;
      }
      return false;
    };
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      if (b.pyClass) {
        for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|${PYB})self\\.([A-Za-z_]\\w*)\\s*${ANN}=\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // multi-line prose container (docstring / triple-quoted constant): never mint a field (Loop 297)
          if (m[1] && pyProseGuard(m)) continue; // inline position: prose guard
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // Loop 311: conditional RHS with a non-proven else arm never mints a field
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[2], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
        // Loop 323: single-line GUARDED-IF lazy-init on a self field — the
        // Python mirror of the JS this-field verdict (Loop 321) and the
        // self-field spelling of the local guarded-if (Loop 322):
        //   if not self.client: self.client = OpenAI(api_key=k)
        //   if self.client is None: self.client = OpenAI(api_key=k)
        // The backreference structurally forces the guard operand to be THE
        // SAME field being assigned — after the statement the field is
        // either its prior cached value or the fresh proven construction
        // (the Loop 239/320/321/322 fallback guarantee). Guard limited to
        // bare falsy (`not self.x`) or None equality (`is None`/`== None`);
        // compound conditions, different targets and non-proven RHS never
        // match (honest skip / AST track). Line-anchored on `if`, so
        // `#`-comment lookalikes are structurally rejected; docstring /
        // triple-quoted containers by bindingProseGuard. The proof index
        // joins selfProvenIdx so the file-level ambiguity guard below never
        // vetoes its own evidence; any OTHER non-proven write to the field
        // still drops it (safe direction).
        for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+not\\s+self\\.([A-Za-z_]\\w*)\\s*:\\s*self\\.\\1\\s*=\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint a field
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // trailing nested conditional: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+self\\.([A-Za-z_]\\w*)\\s+(?:is|==)\\s+None\\s*:\\s*self\\.\\1\\s*=\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint a field
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // trailing nested conditional: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
        // Loop 358: chained assignment with a self-field target — the
        // Python composition of Loop 348 (chained assignment binds EVERY
        // target to the same RHS value; language semantics, not guessing)
        // and Loop 209 (a proven ctor RHS mints a self-field), mirroring
        // the PHP field-target chained verdict (Loop 352):
        //   self.sc = client = OpenAI(api_key=k)      (field-first)
        //   client = self.sc = OpenAI(api_key=k)      (var-first)
        //   self.sc = self.alias = OpenAI(api_key=k)  (field-to-field)
        // Two targets only (3+ structurally fail — the constructor name
        // must directly follow the second `=`; honest skip, AST track);
        // `=(?!=)` on both operators rejects comparison lookalikes; PEP 526
        // annotations are grammatically illegal in chained assignment, so
        // no annotation slot; line-anchored at statement start (inline
        // compound-suite positions stay an honest skip). Same guard set as
        // the plain forms. Field proofs join selfProvenIdx; mid-line field
        // writes (var-first second position / field-to-field second field)
        // are not anchor-visible to the file-level ambiguity guard, so the
        // guard never vetoes its own evidence.
        for (const m of text.matchAll(new RegExp(`^[ \\t]*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: name, named: false });
          instances.set(m[2], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=(?!=)\\s*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          instances.set(m[1], { mod: b.mod, ctor: name, named: false });
          pySelfFields.set(m[2], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: name, named: false });
          pySelfFields.set(m[2], { mod: b.mod, ctor: name, named: false });
          selfProvenIdx.add(m.index);
        }
      }
      if (b.pyModule) {
        for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|${PYB})self\\.([A-Za-z_]\\w*)\\s*${ANN}=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // multi-line prose container (docstring / triple-quoted constant): never mint a field (Loop 297)
          if (m[1] && pyProseGuard(m)) continue; // inline position: prose guard
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // Loop 311
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[2], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          selfProvenIdx.add(m.index);
        }
        // Loop 358: chained assignment with a self-field target — depth-1
        // module-attribute spelling of the pyClass chained forms above
        // (same verdict and guard set; see the Loop 358 comment block).
        for (const m of text.matchAll(new RegExp(`^[ \\t]*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          instances.set(m[2], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=(?!=)\\s*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          instances.set(m[1], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          pySelfFields.set(m[2], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*self\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[3])}\\s*\\(`))) continue; // conditional RHS: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          pySelfFields.set(m[2], { mod: b.mod, ctor: `${name}.${m[3]}`, named: false });
          selfProvenIdx.add(m.index);
        }
        // Loop 323: single-line guarded-if spelling of the same depth-1
        // proof on a self field — same rules as the pyClass guarded-if form
        // above (backreference forces guard operand ≡ assignment target;
        // guard limited to bare falsy or None equality; line anchor +
        // bindingProseGuard + pyCondArmGuard; proof joins selfProvenIdx);
        // exactly ONE attribute segment, matching the plain form.
        for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+not\\s+self\\.([A-Za-z_]\\w*)\\s*:\\s*self\\.\\1\\s*=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint a field
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // trailing nested conditional: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
          selfProvenIdx.add(m.index);
        }
        for (const m of text.matchAll(new RegExp(`^[ \\t]*if\\s+self\\.([A-Za-z_]\\w*)\\s+(?:is|==)\\s+None\\s*:\\s*self\\.\\1\\s*=\\s*${e}\\.([A-Za-z_]\\w*)\\s*\\(`, 'gm'))) {
          if (bindingProseGuard(m)) continue; // docstring/triple-quoted body: never mint a field
          if (pyCondArmGuard(m, new RegExp(`^${e}\\.${escapeRe(m[2])}\\s*\\(`))) continue; // trailing nested conditional: never guess
          if (!pyCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 338)
          pySelfFields.set(m[1], { mod: b.mod, ctor: `${name}.${m[2]}`, named: false });
          selfProvenIdx.add(m.index);
        }
      }
    }
    // Loop 210: Python setter/method injection — the Python mirror of the
    // PHP setter-injection proof (Loop 207) and the TS one (Loop 208). A
    // type-annotated parameter in any single-line `def` signature is a
    // binding proof (the annotation names a proven provider class — the
    // same evidence PEP 526 carries on assignments), and a pure hand-off
    // statement (`self.f = p`, line ends right after the param) transfers
    // that proof to the instance field:
    //   def set_client(self, c: OpenAI):
    //       self.c = c
    // Guards (all mirrored from the PHP/TS passes):
    //   - the same param name annotated against two different providers
    //     anywhere in the file drops the param entirely (never guess);
    //   - the same param name appearing in MORE THAN ONE single-line `def`
    //     signature (typed or untyped) drops it — scope is per-method but
    //     this pass is file-level, so a reused name makes every hand-off
    //     ambiguous;
    //   - any other write to the param (plain/augmented `=`, `for p in`,
    //     `as p` rebinding) anywhere in the file drops it, with the proven
    //     hand-off statements themselves removed from the text first;
    //   - defaulted params (`c: OpenAI = None`) never match — the annotation
    //     must terminate at `,` or `)`, so an `=` default structurally
    //     rejects (the param may hold the default, not the client).
    // Multi-line signatures are not line-anchored evidence -> AST track.
    // Collected fields join pySelfFields, so the consumer-side `self.`
    // dispatch and the field ambiguity guard below apply unchanged
    // (named:false always — Python sites never emit controller-call
    // companions).
    {
      const pyParams = new Map(); // paramName -> { mod, ctor }
      const paramConflicts = new Set();
      const paramSigCount = new Map();
      for (const sig of text.matchAll(/^[ \t]*def\s+[A-Za-z_]\w*\s*\(([^)\n]*)\)\s*(?:->\s*[^:\n]+)?:/gm)) {
        const seen = new Set();
        for (const pv of sig[1].matchAll(/(?:^|,)\s*\*{0,2}([A-Za-z_]\w*)/g)) {
          if (pv[1] !== 'self' && pv[1] !== 'cls') seen.add(pv[1]);
        }
        for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
        for (const [name, b] of bindings) {
          const e2 = escapeRe(name);
          const putParam = (p, ctor, mod) => {
            const prev = pyParams.get(p);
            if (prev && prev.mod !== mod) { paramConflicts.add(p); return; }
            pyParams.set(p, { mod, ctor });
          };
          if (b.pyClass) {
            for (const pm of sig[1].matchAll(new RegExp(`(?:^|,)\\s*([A-Za-z_]\\w*)\\s*:\\s*${e2}(?=\\s*(?:,|$))`, 'g'))) {
              if (pm[1] !== 'self') putParam(pm[1], name, b.mod);
            }
          }
          if (b.pyModule) {
            for (const pm of sig[1].matchAll(new RegExp(`(?:^|,)\\s*([A-Za-z_]\\w*)\\s*:\\s*${e2}\\.([A-Za-z_]\\w*)(?=\\s*(?:,|$))`, 'g'))) {
              if (pm[1] !== 'self') putParam(pm[1], `${name}.${pm[2]}`, b.mod);
            }
          }
        }
      }
      // Loop 230: MULTI-LINE `def` signatures — Black/PEP 8 tooling wraps any
      // signature with several params onto one param per line, so the exact
      // same type-annotated-param proof is routinely spelled as:
      //   def set_client(
      //       self,
      //       wc: OpenAI,
      //   ):
      //       self.wc = wc
      // The opener (`def name(` at statement start) is line-anchored; a
      // balanced-paren walk collects the parameter text (the Loop 221/222/227
      // judgment ported to Python). The trailer after the closing paren must
      // be an optional `-> type` return annotation followed by `:` (a def
      // header and nothing else). Before matching, lookalike surfaces are
      // scrubbed from the param text: `#` comments, string literals (default
      // values), and brace-balanced regions (dict/set defaults — their
      // `key: Value` members spell like typed params but never are).
      // Unbalanced parens skip the opener entirely — prefer missing a binding
      // over guessing. Defaulted params still structurally reject (the
      // annotation must terminate at `,`, line end, or the param-list end).
      // All downstream guards apply unchanged; wrapped-signature params feed
      // paramSigCount too, so a name reused across wrapped and single-line
      // signatures drops as before.
      for (const cm of text.matchAll(/^[ \t]*def\s+[A-Za-z_]\w*\s*\(/gm)) {
        let depth = 1;
        let i = cm.index + cm[0].length;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        if (!/^\s*(?:->[^:\n]+)?\s*:/.test(text.slice(i))) continue; // not a def header trailer
        const rawParams = text.slice(cm.index + cm[0].length, i - 1);
        if (!rawParams.includes('\n')) continue; // single-line handled by the anchored matcher above
        const noProse = rawParams
          .replace(/#[^\n]*/g, '')
          .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'[^'\n]*'|"[^"\n]*"/g, "''");
        let scrubbed = '';
        let bdepth = 0;
        for (const ch of noProse) {
          if (ch === '{') { bdepth++; continue; }
          if (ch === '}') { if (bdepth > 0) bdepth--; continue; }
          if (bdepth === 0) scrubbed += ch;
        }
        const seen = new Set();
        for (const pv of scrubbed.matchAll(/(?:^|[,\n(])\s*\*{0,2}([A-Za-z_]\w*)/g)) {
          if (pv[1] !== 'self' && pv[1] !== 'cls') seen.add(pv[1]);
        }
        for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
        for (const [name, b] of bindings) {
          const e2 = escapeRe(name);
          const putParam = (p, ctor, mod) => {
            const prev = pyParams.get(p);
            if (prev && prev.mod !== mod) { paramConflicts.add(p); return; }
            pyParams.set(p, { mod, ctor });
          };
          if (b.pyClass) {
            for (const pm of scrubbed.matchAll(new RegExp(`(?:^|[(,\\n])\\s*([A-Za-z_]\\w*)\\s*:\\s*${e2}(?=\\s*(?:,|$))`, 'gm'))) {
              if (pm[1] !== 'self') putParam(pm[1], name, b.mod);
            }
          }
          if (b.pyModule) {
            for (const pm of scrubbed.matchAll(new RegExp(`(?:^|[(,\\n])\\s*([A-Za-z_]\\w*)\\s*:\\s*${e2}\\.([A-Za-z_]\\w*)(?=\\s*(?:,|$))`, 'gm'))) {
              if (pm[1] !== 'self') putParam(pm[1], `${name}.${pm[2]}`, b.mod);
            }
          }
        }
      }
      for (const [v, n] of paramSigCount) if (n > 1) paramConflicts.add(v);
      for (const p of paramConflicts) pyParams.delete(p);
      for (const [p, info] of pyParams) {
        const ep = escapeRe(p);
        // Loop 214: besides the statement-start position, the hand-off may
        // sit in a single-line def suite (`def set_c(self, c: OpenAI):
        // self.c = c`) or as a `;`-separated second statement — the same
        // inline-boundary judgment as the ctor form above (Loop 213): a
        // suite colon can only follow a `)` header or else/try/finally, so
        // an annotated-assignment lookalike structurally never matches.
        // Inline positions carry the same prose guard (commented or
        // in-string lookalikes must never mint a binding).
        const handOffRe = new RegExp(`(?:^[ \\t]*|${PYB})self\\.([A-Za-z_]\\w*)\\s*${ANN}=\\s*${ep}\\s*(?:#.*)?$`, 'gm');
        // any other write to the param anywhere in the file drops it: the
        // proven hand-off statements are removed from the text first so
        // they never self-veto (the boundary token, part of the def header,
        // is kept). `for p in` and `as p` rebinding also drop.
        const scrubbed = text.replace(new RegExp(handOffRe.source, 'gm'), (full, b) => b || '');
        if (new RegExp(`(?<![.\\w])${ep}\\s*(?:[+\\-*/%&|^@]|//|\\*\\*)?=(?!=)`).test(scrubbed)) continue;
        if (new RegExp(`(?:^|[ \\t(])for\\s+${ep}\\b`, 'm').test(scrubbed)) continue;
        if (new RegExp(`\\bas\\s+${ep}\\b`).test(scrubbed)) continue;
        for (const m of text.matchAll(handOffRe)) {
          // Loop 308: multi-line prose container guard — the Python mirror
          // of the TS setter fix (Loop 307). A hand-off line quoted inside
          // a docstring / triple-quoted constant (`self.c = c` at line
          // start in a migration note) matched the line-anchored branch
          // and MINTED A PHANTOM FIELD (probe-verified live,
          // loop/evidence/probe-loop308 a/d/f). A guarded-away real
          // hand-off can only DROP a field via the ambiguity guard below
          // (miss, never a false positive) — the safe direction.
          if (bindingProseGuard(m)) continue;
          if (m[1] && pyProseGuard(m)) continue; // inline position: prose guard
          const prev = pySelfFields.get(m[2]);
          if (prev && prev.mod !== info.mod) { pySelfFields.delete(m[2]); continue; }
          pySelfFields.set(m[2], { mod: info.mod, ctor: info.ctor, named: false });
          selfProvenIdx.add(m.index);
        }
      }
    }
    if (pySelfFields.size) {
      // Ambiguity guard: any other assignment to a collected field name
      // (plain or augmented `=`, never `==` comparisons) unbinds it.
      // Extended symmetrically to inline (suite-colon/`;`-prefixed)
      // positions — deliberately WITHOUT the prose guard: a lookalike here
      // can only DROP a field (miss, never a false positive), which is the
      // safe direction (Loop 212 rationale).
      for (const m of text.matchAll(new RegExp(`(?:^[ \\t]*|(?:\\)\\s*(?:->[^:\\n]+)?|\\b(?:else|try|finally))\\s*:[ \\t]*|;[ \\t]*)self\\.([A-Za-z_]\\w*)\\s*(?::[ \\t]*[A-Za-z_][\\w.]*(?:\\[[^\\]\\n=]*\\])?[ \\t]*)?(?:[+\\-*/%&|^@]|//|\\*\\*)?=(?!=)`, 'gm'))) {
        if (!pySelfFields.has(m[1]) || selfProvenIdx.has(m.index)) continue;
        // Loop 324: None-init whitelist. A plain `self.x = None` (the
        // canonical __init__ placeholder for a lazily constructed client)
        // is "not yet constructed", never "a different construction" — it
        // carries no ambiguity about what the field holds once built, so
        // it must not drop a proven guarded-if binding. Strictly limited:
        // plain `=` only (augmented ops never whitelisted) and the RHS up
        // to end-of-line/comment must be exactly the None literal — any
        // other expression (conditional `None if f else make()`, calls,
        // names) still drops via the guard (safe direction unchanged).
        if (!/(?:[+\-*/%&|^@]|\/\/|\*\*)=$/.test(m[0])) {
          const rest = text.slice(m.index + m[0].length, text.indexOf('\n', m.index + m[0].length) === -1 ? undefined : text.indexOf('\n', m.index + m[0].length));
          if (/^[ \t]*None[ \t]*(?:#.*)?$/.test(rest)) continue;
        }
        pySelfFields.delete(m[1]);
      }
    }
  }

  // Loop 206: TS typed class fields — the TS mirror of the PHP typed-property
  // proof (Loop 205). Two spellings, both licensed by the type system itself
  // (tsc enforces every assignment to the field at compile time, so whatever
  // the field holds IS that class — the same license PHP typed properties
  // carry at runtime):
  //   private readonly sc: Stripe;                       (field declaration)
  //   constructor(private readonly stripe: Stripe) {}    (parameter property)
  // The bare `<Binding>;`/`,`/`)` terminator structurally rejects union types
  // (`Stripe | null` never matches — honest not-bound) and generic wrappers.
  // Optional (`?`) and definite-assignment (`!`) modifiers are accepted: the
  // declared type is still the binding. Exempt from the plain-assignment
  // ambiguity guard above (the type system, not the assignment, carries the
  // proof), but conflict-guarded: the same field name typed against two
  // different providers anywhere in the file drops the field entirely
  // (file-level scope, never guess which class a `this.` chain belongs to).
  // Single-line constructor signatures only (multi-line signatures are not
  // line-anchored evidence -> AST track). Gated to .ts/.tsx: type annotations
  // in a .js file are string/prose content, never a binding.
  const jsTypedFields = new Map(); // fieldName -> { mod, ctor, named }
  if (isTs && !isPy && !isRb && !isGo && !isPhp && bindings.size) {
    // Loop 215: interface / type-literal / ambient (`declare class`) members
    // are NOT class fields — `interface Holder { sc: Stripe; }` declares a
    // shape, it never proves what `this.sc` holds in any class in the file.
    // The field-declaration spelling is identical inside those blocks, so
    // matches whose index falls inside such a block are skipped. Spans are
    // found by a balanced-brace walk from each interface/type/declare-class
    // opener; a lookalike opener inside a string could only widen a skip
    // span, which can only DROP a candidate (miss, never a false positive) —
    // the safe direction. Loop 218: multi-line openers (`type X =\n{`,
    // Allman-style `interface X\n{`) are tracked too — after the opener
    // line, only whitespace/newlines may precede the `{` (the grammar
    // requires `{` as the next token, so this can never skip real code).
    // Loop 219: comment lines between the opener and its brace are tracked
    // too — the gap accepts whitespace, `//` line comments, and `/* */`
    // block comments (grammar still requires `{` as the next TOKEN, and a
    // lookalike opener could only widen a skip span, which can only DROP a
    // candidate — the safe direction).
    const tsNonClassSpans = [];
    const walkSpan = (m) => {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      tsNonClassSpans.push([m.index, i]);
    };
    const GAP = String.raw`(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*`;
    for (const m of text.matchAll(new RegExp(String.raw`^[ \t]*(?:export\s+)?(?:declare\s+(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*|(?:declare\s+)?interface\s+[A-Za-z_$][\w$]*|(?:declare\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^>=\n]*>)?\s*=)[^{\n]*` + GAP + String.raw`\{`, 'gm'))) walkSpan(m);
    // Loop 216: inline type-literal contexts — a `{` opened right after `:`
    // (annotation position), `as`, or `satisfies` is a type literal, never a
    // class body. Members inside spell exactly like typed class fields
    // (`(o: { sc: Stripe; })`), so those spans are skipped too. A lookalike
    // opener could only widen a skip span, which can only DROP a candidate
    // (miss, never a false positive) — the same safe direction as above.
    // Loop 217: `extends` joins the opener set — a `{` directly after
    // `extends` only occurs in type positions (generic constraints
    // `<T extends { sc: Stripe; }>`, conditional types). A class heritage
    // clause can never put `{` right after `extends` (extends takes a
    // LeftHandSideExpression, which cannot start with `{`), so this opener
    // can never swallow a real class body.
    // Loop 236: `=` joins the opener set — a `{` directly after `=` is an
    // object literal (value position), a destructuring default, or a generic
    // DEFAULT type literal (`class C<T = { sc: Stripe; }>` — the previously
    // untracked Loop 220 limitation, proven a REAL false-positive path by
    // probe: the member spells exactly like a typed class field and falsely
    // bound an unrelated `this.sc` chain). None of the three can be a class
    // body: a class body's `{` never directly follows `=` (`= class {` has
    // the keyword between, `=> {` has `>` blocking the whitespace-only gap).
    // Structural rejection, not a heuristic; and as with every opener here,
    // a widened skip span can only DROP a candidate — the safe direction.
    for (const m of text.matchAll(/(?::|\bas|\bsatisfies|\bextends|=)\s*\{/g)) walkSpan(m);
    const inTsNonClass = (idx) => tsNonClassSpans.some(([a, b]) => idx >= a && idx < b);
    const tfConflicts = new Set();
    const put = (field, b, name) => {
      const prev = jsTypedFields.get(field);
      if (prev && prev.mod !== b.mod) { tfConflicts.add(field); return; }
      jsTypedFields.set(field, { mod: b.mod, ctor: name, named: b.named });
    };
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      // typed class-field declaration: statement-start, terminated right
      // after the binding name (`;` end-of-line) — object-literal entries
      // (`,`-separated, value position) and unions never match.
      // Loop 364: `#?` admits ES2022 hash-private typed fields (`#gw: Stripe;`)
      // in both declaration positions — the Loop 361 ruling verbatim: `#` is
      // just the field spelling, the type annotation is the same tsc-enforced
      // proof, and the key is stored WITH `#` so minting, conflicts and the
      // consumer dispatch (which admits `#` since Loop 361) agree on one
      // spelling. `#ident :` at statement start is only legal inside a class
      // body, so the structural proof is even stronger than the public form.
      for (const m of text.matchAll(new RegExp('^[ \\t]*(?:(?:public|private|protected|readonly|static)\\s+)*(#?[A-Za-z_$][\\w$]*)[?!]?\\s*:\\s*' + e + '\\s*;\\s*$', 'gm'))) {
        if (inTsNonClass(m.index)) continue; // Loop 215: interface/type/ambient member, not a class field
        put(m[1], b, name);
      }
      // Loop 220: single-line class bodies — the same typed-field declaration
      // may sit after a `{` or `;` statement-boundary token on one line
      // (`class X { sc: Stripe; constructor(...) {...} }`). Both tokens are
      // unambiguous boundaries here because the declaration is `;`-terminated:
      // object literals separate entries with commas, so `ident: Type;` after
      // `{`/`;` can never be a value-position entry. Type-literal contexts
      // (annotation/`as`/`satisfies`/`extends`/interface/type-alias) spell
      // members identically but are excluded by the same span guard as the
      // line-anchored form. Because this variant is NOT line-anchored, the
      // inline code-position (prose) guard applies (commented or in-string
      // lookalikes never mint a binding). Honest limitation (contrived, not
      // tracked): a provider-typed member inside a generic *default* type
      // literal (`class C<T = { sc: Stripe; }>`) is not span-guarded.
      for (const m of text.matchAll(new RegExp('[{;][ \\t]*(?:(?:public|private|protected|readonly|static)\\s+)*(#?[A-Za-z_$][\\w$]*)[?!]?\\s*:\\s*' + e + '\\s*;', 'g'))) {
        if (inTsNonClass(m.index)) continue;
        if (inlineProseGuard(m)) continue; // inline position: prose guard
        put(m[1], b, name);
      }
      // parameter property: the access modifier is what promotes the param
      // to a class field (TS spec), so at least one modifier is required.
      for (const sig of text.matchAll(/^[ \t]*(?:public\s+|private\s+|protected\s+)?constructor\s*\(([^)\n]*)\)/gm)) {
        for (const pm of sig[1].matchAll(new RegExp(`(?:public|private|protected|readonly)\\s+(?:readonly\\s+)?([A-Za-z_$][\\w$]*)\\s*:\\s*${e}(?=\\s*(?:,|$))`, 'g'))) {
          put(pm[1], b, name);
        }
      }
      // Loop 221: MULTI-LINE constructor signatures — Prettier wraps any ctor
      // with several params onto one param per line, which is the default
      // NestJS/DI spelling in real codebases:
      //   constructor(
      //     private readonly stripe: Stripe,
      //     private readonly logger: Console,
      //   ) {}
      // The opener (`constructor(` at statement start, optional visibility
      // modifier prefix) is line-anchored; a balanced-paren walk collects the
      // parameter text. Before matching, three lookalike surfaces are
      // scrubbed from the param text: line/block comments, string literals
      // (default values), and brace-balanced regions (inline type literals /
      // object defaults — their members spell like parameter properties but
      // never are). After the scrub, a `public|private|protected|readonly`
      // modifier followed by `name: <proven binding>` terminated by `,`,
      // line end, or the closing paren is grammatically a parameter property
      // and nothing else. Openers inside interface/type/ambient spans are
      // skipped (construct-signature declarations are not parameter-property
      // sites). Unbalanced parens (pathological/prose input) skip the opener
      // entirely — prefer missing a binding over guessing.
      for (const cm of text.matchAll(/^[ \t]*(?:(?:public|private|protected)\s+)?constructor\s*\(/gm)) {
        if (inTsNonClass(cm.index)) continue;
        let depth = 1;
        let i = cm.index + cm[0].length;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        const rawParams = text.slice(cm.index + cm[0].length, i - 1);
        if (!rawParams.includes('\n')) continue; // single-line handled by the anchored matcher above
        const noProse = rawParams
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
        let scrubbed = '';
        let bdepth = 0;
        for (const ch of noProse) {
          if (ch === '{') { bdepth++; continue; }
          if (ch === '}') { if (bdepth > 0) bdepth--; continue; }
          if (bdepth === 0) scrubbed += ch;
        }
        for (const pm of scrubbed.matchAll(new RegExp(`(?:public|private|protected|readonly)\\s+(?:readonly\\s+)?([A-Za-z_$][\\w$]*)\\s*:\\s*${e}(?=\\s*(?:,|$))`, 'gm'))) {
          put(pm[1], b, name);
        }
      }
    }
    for (const f of tfConflicts) jsTypedFields.delete(f);
  }

  // Loop 208: TS setter/method injection — the TS mirror of the PHP
  // setter-injection proof (Loop 207). A type-annotated parameter in any
  // single-line method signature is a binding proof (tsc enforces the type
  // at every call site), and a pure hand-off assignment (`this.f = p;`)
  // transfers that proof to the class field:
  //   setClient(sc: Stripe): void { this.sc = sc; }
  //   constructor(sc: Stripe) { this.sc = sc; }   (plain ctor param, no modifier)
  // Guards (all mirrored from the PHP pass):
  //   - the same param name type-annotated against two different providers
  //     anywhere in the file drops the param entirely (never guess);
  //   - the same param name appearing in MORE THAN ONE single-line method
  //     signature (typed or untyped) drops it — the scope is per-method but
  //     this pass is file-level, so a reused name makes every hand-off
  //     ambiguous;
  //   - any other write to the param variable in the file drops it;
  //   - any non-proven assignment to a collected field drops the field.
  // Multi-line signatures are not line-anchored evidence -> AST track.
  // The signature must carry a same-line body brace (`{`, after an optional
  // return type) so interface/overload declarations and call statements
  // never match; control-flow keywords are rejected by name. Gated to
  // .ts/.tsx (type annotations in a .js file are prose, never a binding).
  const jsSetterFields = new Map(); // fieldName -> { mod, ctor, named }
  if (isTs && !isPy && !isRb && !isGo && !isPhp && bindings.size) {
    const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'typeof', 'new']);
    const tsParams = new Map(); // paramName -> { mod, ctor, named }
    const paramConflicts = new Set();
    const paramSigCount = new Map(); // paramName -> #signatures mentioning it
    for (const sig of text.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\(([^)\n]*)\)\s*(?::\s*[\w$.<>\[\], |]+)?\s*\{/gm)) {
      if (KW.has(sig[1])) continue;
      const seen = new Set();
      for (const pv of sig[2].matchAll(/(?:^|,)\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g)) seen.add(pv[1]);
      for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
      for (const [name, b] of bindings) {
        for (const pm of sig[2].matchAll(new RegExp(`(?:^|[(,])\\s*([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*${escapeRe(name)}(?=\\s*(?:,|$))`, 'g'))) {
          const prev = tsParams.get(pm[1]);
          if (prev && prev.mod !== b.mod) { paramConflicts.add(pm[1]); continue; }
          tsParams.set(pm[1], { mod: b.mod, ctor: name, named: b.named });
        }
      }
    }
    // Loop 227: MULTI-LINE method signatures — Prettier wraps any signature
    // with several params onto one param per line, so the exact same
    // type-annotated-param proof is routinely spelled as:
    //   setClient(
    //     sc: Stripe,
    //   ): void { this.sc = sc; }
    // The opener (`name(` at statement start, optional modifier prefix,
    // control-flow keywords rejected by name) is line-anchored; a
    // balanced-paren walk collects the parameter text (Loop 221/222 judgment
    // ported to the setter pass). The signature must still carry a body
    // brace after the closing paren (optional return type first) so
    // interface/overload declarations and plain call statements never match.
    // Before matching, lookalike surfaces are scrubbed from the param text:
    // line/block comments, string literals (default values), and
    // brace-balanced regions (inline type literals / object defaults —
    // their members spell like typed params but never are). Unbalanced
    // parens skip the opener entirely — prefer missing a binding over
    // guessing. All downstream guards (param reuse across signatures,
    // cross-provider conflict, any other write to the param) apply
    // unchanged; wrapped-signature params feed paramSigCount too.
    for (const cm of text.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm)) {
      if (KW.has(cm[1])) continue;
      let depth = 1;
      let i = cm.index + cm[0].length;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      if (depth !== 0) continue; // unbalanced: never guess
      if (!/^\s*(?::\s*[\w$.<>\[\], |]+)?\s*\{/.test(text.slice(i))) continue; // no body brace: declaration/overload/call
      const rawParams = text.slice(cm.index + cm[0].length, i - 1);
      if (!rawParams.includes('\n')) continue; // single-line handled by the anchored matcher above
      const noProse = rawParams
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
      let scrubbed = '';
      let bdepth = 0;
      for (const ch of noProse) {
        if (ch === '{') { bdepth++; continue; }
        if (ch === '}') { if (bdepth > 0) bdepth--; continue; }
        if (bdepth === 0) scrubbed += ch;
      }
      const seen = new Set();
      for (const pv of scrubbed.matchAll(/(?:^|[,\n(])\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g)) seen.add(pv[1]);
      for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
      for (const [name, b] of bindings) {
        for (const pm of scrubbed.matchAll(new RegExp(`(?:^|[(,\\n])\\s*([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*${escapeRe(name)}(?=\\s*(?:,|$))`, 'gm'))) {
          const prev = tsParams.get(pm[1]);
          if (prev && prev.mod !== b.mod) { paramConflicts.add(pm[1]); continue; }
          tsParams.set(pm[1], { mod: b.mod, ctor: name, named: b.named });
        }
      }
    }
    for (const [v, n] of paramSigCount) if (n > 1) paramConflicts.add(v);
    for (const p of paramConflicts) tsParams.delete(p);
    const setterProvenIdx = new Set();
    const fieldConflicts = new Set();
    for (const [p, info] of tsParams) {
      // any other write to the param variable anywhere in the file drops it
      // Loop 364: `#?` admits hash-private hand-off targets (`this.#f = sc;`)
      // — Loop 361 ruling verbatim; the scrub regex, the minting matcher and
      // the ambiguity guard below all carry the same spelling so they agree.
      if (new RegExp(`(?<![.\\w$])${escapeRe(p)}\\s*=(?![=>])`).test(text.replace(new RegExp(`this\\s*\\.\\s*#?[A-Za-z_$][\\w$]*\\s*=\\s*${escapeRe(p)}\\s*;`, 'g'), ''))) continue;
      for (const m of text.matchAll(new RegExp(`this\\s*\\.\\s*(#?[A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRe(p)}\\s*;`, 'g'))) {
        // Loop 307: prose guards — this matcher is NOT line-anchored, so a
        // hand-off line quoted in a comment (`// old form: this.sc = sc;`),
        // a string literal (`"this.sc = sc;"`), or a multi-line prose
        // container (template/block comment body) spelled exactly like the
        // real statement and MINTED A PHANTOM FIELD (probe-verified live,
        // /tmp/l307p h/i). Both guards mirror the this-field pass: the
        // multi-line container guard (bindingProseGuard, Loop 296) plus the
        // same-line code-position guard (inlineProseGuard, Loop 212 — a
        // `//`/`/*` opener or an unclosed quote before the match means the
        // lookalike is prose). A guarded-away real hand-off can only DROP a
        // field via the ambiguity guard below (miss, never a false
        // positive) — the safe direction.
        if (bindingProseGuard(m)) continue;
        if (inlineProseGuard(m)) continue;
        const prev = jsSetterFields.get(m[1]);
        if (prev && prev.mod !== info.mod) { fieldConflicts.add(m[1]); continue; }
        jsSetterFields.set(m[1], { mod: info.mod, ctor: info.ctor, named: info.named });
        setterProvenIdx.add(m.index);
      }
    }
    for (const f of fieldConflicts) jsSetterFields.delete(f);
    if (jsSetterFields.size) {
      // Ambiguity guard: any non-proven assignment to a collected field
      // (plain/logical `=`, never `==` comparisons) unbinds it.
      for (const m of text.matchAll(/this\s*\.\s*(#?[A-Za-z_$][\w$]*)\s*(?:\?\?|\|\||&&)?=(?!=)/g)) {
        if (jsSetterFields.has(m[1]) && !setterProvenIdx.has(m.index)) jsSetterFields.delete(m[1]);
      }
    }
  }

  // Loop 373: plain-local instance rebinding guard — the instances map above
  // had NO file-level ambiguity guard: `let sc = new Stripe(k)` followed by
  // `sc = makeLegacyGateway()` kept emitting the legacy chains as provider
  // surfaces (probe-verified FALSE POSITIVE, loop/evidence/probe-loop373 pa;
  // recorded as the pg candidate in Loop 371). Every comparable holder
  // already has this guard (this-fields Loop 212/232, hash-fields Loop
  // 365/366, container fields Loop 368, destructured/alias locals Loop
  // 371/372) — plain locals were the last unguarded holder. Ruling: a
  // statement-start (or `{`/`;` inline) reassignment of an instance name
  // drops the instance UNLESS the RHS is itself proven:
  //   - a construction from a proven import binding of the SAME module
  //     anywhere in the RHS statement (covers the plain, fallback
  //     `?? new` / `|| new`, both-arms ternary and chained-assignment
  //     spellings the mint passes above already accept; a DIFFERENT
  //     module's construction is ambiguous and drops)
  //   - a bare null/undefined placeholder (the teardown/reset idiom —
  //     Loop 325 whitelist carried over verbatim)
  //   - the Loop 372 alias declaration itself (jsAliasProvenIdx — its RHS
  //     is a proven container field, not a construction)
  // A mixed RHS that CONTAINS a proven same-module construction (e.g.
  // `flag ? new Stripe(k) : makeFake()`) keeps the binding — that is the
  // pre-373 status quo, deliberately not tightened this round (recorded as
  // an honest residual; tightening it needs arm-level adjudication, AST
  // track). The guard is deliberately prose-naive: a lookalike inside a
  // string can only DROP a binding (miss, never a false positive — the
  // safe direction), while line-anchoring already rejects `//`-commented
  // lookalikes structurally (the comment opener precedes the identifier).
  if (!isPy && !isRb && !isGo && !isPhp && instances.size) {
    for (const [name, info] of [...instances]) {
      const guardRe = new RegExp(`(?:^[ \\t]*|[{;][ \\t]*)(?:(?:const|let|var)[ \\t]+)?${escapeRe(name)}\\s*(?:\\?\\?|\\|\\||&&)?=(?!=|>)`, 'gm');
      for (const g of text.matchAll(guardRe)) {
        if (jsAliasProvenIdx.has(g.index)) continue; // Loop 372 alias declaration: proven RHS
        let rhs = text.slice(g.index + g[0].length);
        const stop = rhs.search(/[;\n]|\/\//);
        if (stop !== -1) rhs = rhs.slice(0, stop);
        rhs = rhs.trim();
        if (rhs === 'null' || rhs === 'undefined') continue; // placeholder reset (Loop 325 whitelist)
        let proven = false;
        for (const cm of rhs.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) {
          const cb = bindings.get(cm[1]);
          if (cb && cb.mod === info.mod) { proven = true; break; } // re-construction from the same proven binding
        }
        if (proven) continue;
        instances.delete(name); // non-proven reassignment: the local no longer holds the proven client
        break;
      }
    }
  }

  // Loop 375: bare-identifier alias of a proven plain-local instance —
  //   const sc = new Stripe(key);
  //   const gateway = sc;          // or let/var; renamed local
  //   ...later: gateway.charges.create(...)
  // The zero-segment twin of the Loop 372 container-field alias (`const sc =
  // services.sc`) and the degenerate case of the sub-client alias pass below
  // (which requires at least ONE member segment, so a bare identifier RHS
  // never binds there — probe-verified honest miss, loop/evidence/
  // probe-loop375 pa). The RHS is a PURE bare identifier — the statement
  // ends right after it, so no call (cannot be API data) and no member
  // segment (cannot be a derived sub-object): simple assignment copies the
  // reference, so the local holds the same proven client object (value
  // identity, the Loop 370/371/372 reasoning family). The pass runs AFTER
  // the Loop 373 plain-local rebinding guard, so a source instance dropped
  // by that guard can never mint an alias (probe pe). The same extra-strict
  // guard as Loop 371/372 applies to the NEW local: ANY other assignment to
  // it anywhere in the file drops it (probe pd); the declaration itself
  // matches the guard shape and is exempted by exact index. Two
  // declarations of one alias name are ambiguous and drop. Multi-hop
  // (Loop 376): alias of an alias IS followed to a bounded fixpoint —
  // every hop is the exact same single-line structural proof (a pure bare
  // identifier RHS assigned from an already-proven instance), so composing
  // hops composes proofs, the same reasoning the sub-client alias pass
  // below already applies to member-chain hops. Hops are capped
  // (defensive bound only; real code rarely exceeds 2) and already-proven
  // names are never re-bound, so cycles cannot loop: the instances map
  // only ever grows and a proven local never re-enters the matcher.
  // Call-bearing or member-bearing RHS never matches the matcher shape
  // (probe pf / sub-client pass respectively).
  if (!isPy && !isRb && !isGo && !isPhp && instances.size) {
    for (let hop = 0; hop < 4; hop++) {
      const bareAliases = new Map(); // local -> { src, declIdx }
      for (const m of text.matchAll(/(?:^[ \t]*|([{;])[ \t]*)(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|$)/gm)) {
        if (!instances.has(m[3])) continue; // RHS must be a surviving proven instance
        if (bindingProseGuard(m)) continue; // multi-line prose container: never mint
        if (m[1] && inlineProseGuard(m)) continue; // inline position: prose guard
        const local = m[2];
        if (local === m[3]) continue; // self-shadow: not an alias
        if (bindings.has(local) || instances.has(local)) continue; // never shadow a proven name
        if (bareAliases.has(local)) { bareAliases.delete(local); continue; } // two declarations: ambiguous, drop
        bareAliases.set(local, { src: m[3], declIdx: m.index });
      }
      let minted = 0;
      for (const [local, a] of bareAliases) {
        const guardRe = new RegExp(`(?:^[ \\t]*|[{;][ \\t]*)(?:(?:const|let|var)[ \\t]+)?${escapeRe(local)}\\s*(?:\\?\\?|\\|\\||&&)?=(?!=|>)`, 'gm');
        let rebound = false;
        for (const g of text.matchAll(guardRe)) {
          if (g.index === a.declIdx) continue; // the declaration's own guard hit
          rebound = true;
          break;
        }
        if (rebound) continue; // any other assignment: drop (one hop from proof, safe direction)
        const src = instances.get(a.src);
        if (src && !instances.has(local)) {
          instances.set(local, { mod: src.mod, ctor: src.ctor, named: src.named });
          jsAliasProvenIdx.add(a.declIdx); // proven RHS declaration: recorded for guard symmetry with Loop 372
          minted++;
        }
      }
      if (!minted) break; // fixpoint: no new hop proven this round
    }
  }

  const roots = new Map();
  for (const [name, b] of bindings) roots.set(name, { mod: b.mod, ctor: null, named: b.named });
  for (const [name, info] of instances) roots.set(name, info);
  // Cross-module re-export roots: proven in another file, imported here under
  // a local name. Never re-bind an already-proven local name (local proof
  // wins — same shadow-safety rule as alias hops).
  for (const r of externalRoots) {
    if (!roots.has(r.name)) roots.set(r.name, { mod: r.mod, ctor: null, named: false, prefix: r.prefix || [] });
  }

  // Sub-client aliases (JS): a *pure* member expression assigned from a proven
  // root re-roots later chains with the aliased prefix:
  //   const charges = stripe.charges;              -> charges.create(...)
  //   const sessions = stripe.checkout.sessions;   -> sessions.retrieve(...)
  // The proof is line-anchored: the RHS carries no call anywhere (the line
  // ends right after the member chain), so the assigned value cannot be API
  // data — data only ever comes back from a call. RHS expressions containing
  // a call (`const s = stripe.checkout.sessions.create(...)`) never bind:
  // that is real dataflow and stays on the AST track. Aliases of aliases
  // (transitive re-rooting) ARE followed, to a bounded fixpoint: every hop is
  // the exact same line-anchored proof (a pure member expression assigned
  // from an already-proven root), so composing hops composes proofs — no
  // scope tracking is involved because each hop's evidence is a single line.
  // Prefixes accumulate across hops (`const co = stripe.checkout; const s =
  // co.sessions; s.retrieve(...)` -> client.checkout.sessions.retrieve).
  // Hops are capped (defensive bound only; real code rarely exceeds 2) and
  // already-proven names are never re-bound, so cycles cannot loop.
  // The declaration must sit at statement start (line-anchored) so commented
  // declarations (`// const charges = stripe.charges;`) never bind.
  const subAliases = new Map(); // varName -> { mod, prefix: [segs] }
  let aliasFrontier = [...roots.keys()];
  for (let hop = 0; hop < 5 && aliasFrontier.length; hop++) {
    const nextFrontier = [];
    for (const name of aliasFrontier) {
      const info = roots.get(name);
      const e = escapeRe(name);
      const bind = (varName, chainSegs) => {
        if (roots.has(varName)) return; // proven names never re-bound (cycle/shadow safety)
        const prefix = [...(info.prefix || []), ...chainSegs];
        subAliases.set(varName, { mod: info.mod, prefix });
        roots.set(varName, { mod: info.mod, ctor: null, named: false, prefix });
        nextFrontier.push(varName);
      };
      for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?<![\\w$.])${e}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*;?\\s*$`, 'gm'))) {
        bind(m[1], m[2].slice(1).split('.'));
      }
      // Python form of the same proof (bare assignment, no declaration
      // keyword): `chat = client.chat.completions` / `charges = stripe.charges`.
      // Same reasoning as the JS pass above — the RHS is a *pure* member
      // expression (no call anywhere on the line, optional trailing `#`
      // comment), so the assigned value cannot be API data; the root is an
      // already-proven binding/instance. Gated to .py files: the keyword-less
      // form is only licensed by Python syntax (a JS file carrying it would be
      // string/prose content). Call-bearing RHS stays on the AST track,
      // exactly like JS.
      if (isPy) {
        for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*(?<![\\w.])${e}((?:\\.[A-Za-z_]\\w*)+)\\s*(?:#.*)?$`, 'gm'))) {
          bind(m[1], m[2].slice(1).split('.'));
        }
      }
    }
    aliasFrontier = nextFrontier;
  }

  // Export collection mode (JS module-graph support): report which proven
  // roots this file re-exports, so buildInventory can join them into consumer
  // files. Two line-anchored forms only:
  //   export const stripe = new Stripe(...)   (declaration itself proven above
  //   export const charges = stripe.charges;   by the instance/alias passes)
  //   export { stripe, charges as sub }        (named export of a proven root)
  // `export default <proven identifier>` IS collected (sentinel name
  // '@default'): the default export is a per-module singleton, so the
  // consumer-side handshake is the relative specifier itself — the default
  // import of a resolved file unambiguously binds that file's one default
  // export. Both sides are single line-anchored facts; no scope tracking.
  // Only a bare proven identifier qualifies as the default RHS — expressions
  // (`export default new Stripe(...)`) stay on the AST track.
  if (opts.collectExports) {
    const exported = [];
    for (const [name, info] of roots) {
      if (info.named) continue; // named-import class bindings are ctors, not clients
      const e = escapeRe(name);
      if (new RegExp(`^[ \\t]*export\\s+(?:const|let|var)\\s+${e}\\b`, 'm').test(text)) {
        exported.push({ name, mod: info.mod, prefix: info.prefix || [] });
      }
    }
    for (const m of text.matchAll(/^[ \t]*export\s*\{([^}]+)\}\s*;?\s*$/gm)) {
      for (const part of m[1].split(',')) {
        const toks = part.trim().split(/\s+as\s+/);
        const local = (toks[0] || '').trim();
        const pub = (toks[1] || local).trim();
        const info = roots.get(local);
        if (info && !info.named && /^[A-Za-z_$][\w$]*$/.test(pub)) {
          exported.push({ name: pub, mod: info.mod, prefix: info.prefix || [] });
        }
      }
    }
    // Default export of a bare proven identifier: `export default stripe;`.
    // Collected under the sentinel name '@default' — a module has exactly one
    // default export, so the consumer-side default import of this resolved
    // file is an unambiguous handshake. Expressions as the default RHS
    // (`export default new Stripe(...)`) never collect: the RHS must be a
    // single already-proven identifier (line-anchored proof).
    for (const m of text.matchAll(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
      const info = roots.get(m[1]);
      if (info && !info.named) {
        exported.push({ name: '@default', mod: info.mod, prefix: info.prefix || [] });
      }
    }
    // CommonJS named-export forms — the same exported-name handshake as ESM,
    // just spelled differently. Each form is a single line-anchored statement
    // naming both the public name and the proven local root:
    //   exports.stripe = stripe;
    //   module.exports.stripe = stripe;
    //   module.exports = { stripe, stripeClient: sc };   (object literal;
    //   the [^}]* capture also spans simple multi-line literals — nested
    //   braces end the capture early, which can only drop entries, never
    //   mis-attribute)
    // `module.exports = stripe` (bare re-assignment of a proven identifier)
    // IS collected under the same '@default' sentinel: like `export default`,
    // it replaces the module's single export object, so the consumer-side
    // bare require of this resolved file is an unambiguous handshake.
    // Expressions on the RHS never collect (proven identifier only).
    for (const m of text.matchAll(/^[ \t]*module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
      const info = roots.get(m[1]);
      if (info && !info.named) {
        exported.push({ name: '@default', mod: info.mod, prefix: info.prefix || [] });
      }
    }
    for (const m of text.matchAll(/^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
      const info = roots.get(m[2]);
      if (info && !info.named) {
        exported.push({ name: m[1], mod: info.mod, prefix: info.prefix || [] });
      }
    }
    // CJS named slot with a pure-member RHS on a proven root:
    //   exports.charges = stripeA.charges;
    //   module.exports.readers = stripeA.terminal.readers;
    // Same judgment as the sub-client alias pass (pure member RHS, zero
    // calls on the line, root already proven): the member segments simply
    // accumulate as prefix under the published slot — the CJS twin of
    // `export const charges = stripe.charges`. Call-bearing RHS
    // (`= stripeA.charges.create(...)`) never matches: the line-end anchor
    // admits member segments only, so API-data results stay unbound.
    for (const m of text.matchAll(/^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm)) {
      const info = roots.get(m[2]);
      if (info && !info.named && /^[A-Za-z_$][\w$]*$/.test(m[1])) {
        exported.push({ name: m[1], mod: info.mod, prefix: [...(info.prefix || []), ...m[3].slice(1).split('.')] });
      }
    }
    for (const m of text.matchAll(/^[ \t]*module\.exports\s*=\s*\{([^}]*)\}\s*;?\s*$/gm)) {
      for (const part of m[1].split(',')) {
        const toks = part.trim().split(':').map((t) => t.trim());
        const pub = toks[0] || '';
        const local = toks.length > 1 ? toks[1] : pub;
        const info = roots.get(local);
        if (info && !info.named && /^[A-Za-z_$][\w$]*$/.test(pub) && /^[A-Za-z_$][\w$]*$/.test(local)) {
          exported.push({ name: pub, mod: info.mod, prefix: info.prefix || [] });
        }
      }
    }
    return exported;
  }

  const calls = []; // { module, kind, chain, ctor, line, snippet }
  const lines = text.split('\n');

  // Ruby: constant-rooted chains and instance variables. The require line is
  // the binding proof (callers only pass gems required by this file), and the
  // SDK's documented top-level constant (Stripe, Twilio, ...) is the chain
  // root. Two proven forms:
  //   1. direct constant chain call:  Stripe::Charge.create(...)
  //      -> sdk-call `client.Charge.create` (binding-agnostic, segments as
  //         written — `::` path + method chain, call parens required)
  //   2. instance from constructor:   client = Twilio::REST::Client.new(...)
  //      -> `client` joins the chain roots, so client.messages.create(...)
  //         below is collected by the shared chain pass
  // Paren-less constant-chain calls ARE handled, but only when the first
  // trailing token unambiguously starts an argument list: a keyword argument
  // (`customer: id`), a symbol (`:active`), or a string literal. Those
  // starters are line-anchored call proof (prose in strings/heredocs cannot
  // accidentally form `create customer:`). Deliberately NOT handled (AST
  // track): paren-less calls with bare-identifier args (`create amount`,
  // indistinguishable from prose), zero-arg paren-less mentions at end of
  // line, instances assigned from method returns, and constants re-assigned
  // to local variables (aliasing).
  // Loop 337: constructor trailing-chain adjudication. The paren-branch
  // matchers end at `.new(` and never inspected what follows the balanced
  // close paren — `sc = Stripe::StripeClient.new(k).charges` bound `sc` as
  // the CLIENT while the variable actually holds a derived RESOURCE
  // (probe-verified FALSE ATTRIBUTION: the reported surface both dropped
  // the real `.charges` segment and anchored a wrong client.* surface —
  // wrong pack targeting, a direct accuracy hole). Ruling: after the
  // same-line balanced close, the rest of the line must be empty/comment
  // or a chain of value-identity methods (`.freeze`/`.dup`/`.clone` —
  // each returns the same client value or a copy of it); any other
  // `.method` trailer means a derived object => drop (AST track).
  // `.tap` is deliberately NOT whitelisted (block form re-derives).
  // A multi-line argument list (no close on the line) keeps the existing
  // accepted-as-is behavior. Paren-less forms carry their own trailer
  // proof inside the regex and pass through untouched.
  const rbCtorTrailerOk = (m) => {
    if (!m[0].endsWith('(')) return true; // paren-less/EOL branches adjudicate in-pattern
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '\n') return true; // multi-line arg list: accepted as-is
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth !== 0) return true;
    const nl = text.indexOf('\n', i);
    const rest = text.slice(i, nl === -1 ? text.length : nl);
    return /^(?:\.(?:freeze|dup|clone)\b)*[ \t]*(?:#.*)?$/.test(rest);
  };
  const rbInstances = new Map(); // varName -> { mod }
  if (rbConsts.length) {
    for (const { mod, root } of rbConsts) {
      const er = escapeRe(root);
      // instance binding: var = Const(::Path)*.new(
      // Paren-less spellings of the same proof also bind (Loop 199): the RHS
      // of a statement-start assignment ending in `.new` can only be a
      // constructor call in Ruby grammar — `client = Stripe::StripeClient.new`
      // is the documented stripe-ruby v8+ quickstart form. Accepted trailers:
      // `(` (existing), end of line (optionally a `#` comment tail), or an
      // unambiguous argument starter per the Loop 194 criteria — keyword arg
      // (`api_version:`, the (?!:) guard rejects `Const::Path` lookalikes),
      // symbol, or string literal. A bare-identifier trailer (`.new cfg`) or
      // a further chain (`.new.charges`) never binds — prose-ambiguous /
      // value semantics, AST track. The heredoc-body / block-comment
      // lookalike exposure previously accepted as-is is now closed —
      // bindingProseGuard (Loop 298) skips matches starting inside a Ruby
      // prose container (heredoc body, =begin block, carried string frame).
      // Loop 329: the `||=` sugar spelling also binds for LOCALS. `sc ||=
      // Stripe::StripeClient.new(key)` is the same canonical memoization
      // idiom the ivar pass accepted in Loop 305 — `||=` either constructs
      // or keeps a previously constructed value, so binding strength equals
      // plain `=`. `&&=` and augmented ops never match (the optional group
      // admits only `||` before `=`); `==` comparisons never match (the RHS
      // must be the proven constant root). Probe-verified honest miss: the
      // bare-local `||=` file had ALL its chains invisible while the plain
      // `=`, ivar `||=`, and JS/PHP guarded forms of the same idiom bound.
      // Loop 333: the target class admits CONSTANT names too ([A-Za-z_]) —
      // `STRIPE_CLIENT = Stripe::StripeClient.new(...)` is the canonical
      // Rails-initializer / script-level holder (probe-verified honest
      // miss: the constant-holder file had every chain invisible while the
      // lowercase local twin bound). In Ruby grammar an uppercase
      // assignment target IS a constant assignment — same statement shape,
      // same RHS proof, binding strength identical. A namespaced target
      // (`Billing::CLIENT = ...`) never matches (the anchor sits on the
      // first identifier, which is followed by `::`, not `=`), so a bare
      // consumer of the same short name never picks up a foreign proof.
      // Loop 335: every rb binding matcher's RHS also admits the
      // cbase-qualified spelling `::Stripe::StripeClient.new(...)` via an
      // optional leading `(?:::)?` — inside modules/engines this is the
      // defensive form that escapes lexical shadowing and names the SAME
      // top-level constant (require "stripe" defines ::Stripe), so the
      // construction proof is identical. A foreign namespace qualifier
      // (`Foo::Stripe...`) never matches: the optional group admits only a
      // bare leading `::`, and `Foo::` breaks the RHS anchor entirely.
      // Loop 342: the paren-less argument-starter set also admits an ENV
      // argument (`ENV[` / `ENV.fetch`-call) — `sc = Stripe::StripeClient.new
      // ENV["STRIPE_KEY"]` is the documented stripe-ruby quickstart
      // spelling. ENV is a core global constant; `ENV[`/`ENV.fetch`-call right
      // after `.new ` cannot be formed by prose (probe-verified honest
      // miss across local/constant/ivar holders before the fix). Bare
      // identifiers (`.new some_key`) stay prose-ambiguous => AST track.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*(?:\\|\\|)?=\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint an instance (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 337)
        rbInstances.set(m[1], { mod });
      }
      // Loop 350: chained assignment spelling of the same proof —
      //   sc = client = Stripe::StripeClient.new(key)
      // Ruby chained-assignment semantics bind EVERY target to the same
      // RHS value — both names hold the constructed client (language
      // semantics, not chain-shape guessing; the JS Loop 349 / Python
      // Loop 348 ruling carried to Ruby). Targets admit locals AND
      // constants (Loop 333 ruling). Two targets only (3+ stay an honest
      // skip — AST track). `=(?![=~])` on both operators rejects
      // comparison (`a == b == X.new`) and match (`a =~ /x/`) lookalikes.
      // Loop 355: the trailer set now mirrors the PLAIN matcher above —
      // paren, paren-less end-of-line (optionally `#` comment), keyword
      // arg / symbol / string starter (Loop 194 criteria), ENV argument
      // (Loop 342), and value-preserving `.freeze/.dup/.clone` trailers.
      // Probe-verified honest miss: the paren-less chained spellings
      // (`sc = client = Stripe::StripeClient.new` / `.new ENV[...]` /
      // `.new api_key: key`) had BOTH names' chains invisible while the
      // plain paren-less twin bound (Loop 199/342 proofs carry over —
      // chained assignment binds every target to the same RHS value, and
      // the RHS proof is identical to the plain form). Bare-identifier
      // trailers (`.new cfg`) and derived chains (`.new.charges`) still
      // structurally fail the trailer set — prose-ambiguous / derived
      // value, AST track. Same guard set as the plain form: prose guard
      // + ctor-trailer walk.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=(?![=~])\\s*([A-Za-z_]\\w*)\\s*=(?![=~])\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint an instance (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 337)
        rbInstances.set(m[1], { mod });
        rbInstances.set(m[2], { mod });
      }
      // Loop 317: SAME-OPERAND `||` fallback construction — the Ruby local
      // cell of the fallback family (JS `x || new X()` Loop 239 / JS ternary
      // `x ? x : new X()` Loop 310 / Python `x or X()` Loop 315 / Python
      // `x if x else X()` Loop 316 / Ruby ivar `||=` Loop 305):
      //   sc = sc || Stripe::StripeClient.new(key)
      // The backreference `\1` structurally forces the fallback operand to
      // be the SAME local identifier being assigned — the bound name is
      // either the cached value or a proven construction, so binding
      // strength equals plain `=`. A different operand (`x = other || …`)
      // or a call-expression operand (`cached() || …`, not idempotent)
      // never matches — AST track / honest skip. `&&` is structurally
      // excluded (falsy operand means no construction). NOTE: the keyword
      // spelling `sc = sc or X.new` must NOT bind — Ruby's low-precedence
      // `or` parses that line as `(sc = sc) or X.new`, so the variable is
      // NOT proven constructed. Comment lookalikes are rejected by the
      // `^[ \t]*` statement anchor; heredoc/=begin prose by
      // bindingProseGuard. Trailer set mirrors the plain matcher above.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([a-z_]\\w*)\\s*=\\s*\\1\\s*\\|\\|\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint an instance (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 337)
        rbInstances.set(m[1], { mod });
      }
      // Loop 314: BOTH-ARMS ternary construction — the Ruby cell of the
      // test/live key idiom (JS Loop 304 / Python Loop 311 / PHP Loop 312):
      //   sc = test_mode ? Stripe::StripeClient.new(tk) : Stripe::StripeClient.new(lk)
      // Whichever arm wins, the variable holds a construction from the
      // proven constant root — binding strength equals plain `=`. The
      // condition segment admits Ruby predicate-method `?` (`cfg.test? ?`)
      // only as a word-char-attached `?` followed by whitespace
      // (`\w\?(?=[ \t])`); any other bare `?` rejects the line, so the
      // ternary marker we anchor on is unambiguous. The consequent's call
      // must close on the SAME line (balanced-paren walk; multi-line arg
      // lists are an honest skip) and the alternate must itself start with
      // `<ProvenConst>.new(` — a `: nil` / factory else arm stays AST
      // track. Comment lookalikes are structurally rejected by the `^[ \t]*`
      // statement anchor; heredoc/=begin prose by bindingProseGuard.
      const rbTernaryBind = (matches, sink) => {
        for (const m of matches) {
          if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
          let i = m.index + m[0].length; // just past the consequent's opening paren
          let depth = 1;
          while (i < text.length && depth > 0) {
            const ch = text[i];
            if (ch === '\n') break; // consequent must close on the same line — honest skip
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            i++;
          }
          if (depth !== 0) continue;
          while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
          if (text[i] !== ':') continue;
          const nl = text.indexOf('\n', i + 1);
          const rest = text.slice(i + 1, nl === -1 ? text.length : nl);
          sink(m, rest);
        }
      };
      // Loop 334: the ternary target class admits CONSTANT names too
      // ([A-Za-z_]) — `SC_CLIENT = test? ? Client.new(tk) : Client.new(lk)`
      // is the test/live-key idiom at initializer level with a constant
      // holder (probe-verified honest miss while the lowercase twin bound).
      // Same ruling as the Loop 333 plain/`||=` widening: an uppercase
      // assignment target IS a constant assignment, same statement shape,
      // same both-arms proof. A namespaced target (`Billing::SC = …`) never
      // matches (first identifier is followed by `::`, not `=`). NOTE the
      // same-operand `||` fallback matcher stays lowercase-only on purpose:
      // `SC = SC || X.new` is not a real Ruby idiom — an unset constant on
      // the RHS raises NameError and a set one warns on reassign; the real
      // spelling is `SC ||= X.new`, already bound by the widened matcher
      // above.
      rbTernaryBind(text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=\\s*(?:\\w\\?(?=[ \\t])|[^?;\\n])*?\\?[ \\t]+(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*\\(`, 'gm')), (m, rest) => {
        if (!new RegExp(`^[ \\t]*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*\\(`).test(rest)) return; // else arm must also construct — otherwise AST track
        rbInstances.set(m[1], { mod });
      });
    }
    for (const [name, info] of rbInstances) roots.set(name, { mod: info.mod, ctor: null, named: false });
  }

  // Loop 211: Ruby instance variables — the Ruby cell of the OOP
  // instance-field matrix (JS this-field Loop 203 / PHP $this-> Loop 204 /
  // Python self. Loop 209). `@client = Stripe::StripeClient.new` inside
  // `initialize` is the canonical service-class client holder in Ruby.
  // The binding proof is identical to rbInstances above (statement-start
  // assignment whose RHS ends in `.new` with a proven constant root and an
  // unambiguous trailer); only the target spelling changes (`@ivar`).
  // File-level ambiguity guard (mirrored from the JS/PHP/Python passes):
  // any other assignment to the same ivar anywhere in the file (plain,
  // augmented, or `||=`/`&&=` — never `==` comparisons) drops the field
  // entirely — `@ivar` attribution is class-level but this pass is
  // file-level, so a reused name makes attribution unprovable. Never guess.
  // Consumer side: `@ivar.member.method(...)` requires call parens and at
  // least TWO segments after the field (member + method) so `@sc.ping(1)`
  // (attribution too thin) never binds; the rbCodePosition prose guard
  // (string literals / comment tails) applies. Paren-less consumer chains
  // on an ivar stay on the AST track. The heredoc-body / block-comment
  // lookalike exposure previously accepted as-is is now closed —
  // bindingProseGuard (Loop 298) skips matches starting inside a Ruby
  // prose container, same wiring as the rbInstances matcher above.
  const rbIvars = new Map(); // ivarName -> { mod }
  if (rbConsts.length) {
    const ivarProvenIdx = new Set();
    for (const { mod, root } of rbConsts) {
      const er = escapeRe(root);
      // Loop 305: the `||=` spelling also binds. `@client ||= Const.new(...)`
      // is the CANONICAL Ruby memoization idiom (`def client; @client ||= …`
      // is the documented stripe-ruby lazy-init form) and was a probe-verified
      // honest miss: the whole file's field chains stayed invisible. The RHS
      // proof is identical (statement-start write whose RHS ends in `.new`
      // with a proven constant root and an unambiguous trailer) — `||=`
      // either constructs or keeps a previously constructed value, so the
      // binding is as strong as plain `=`. `&&=` and augmented ops stay on
      // the drop side (their RHS never proves construction semantics).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*@([a-z_]\\w*)\\s*(?:\\|\\|)?=\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint a field (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 337)
        const prev = rbIvars.get(m[1]);
        if (prev && prev.mod !== mod) { rbIvars.delete(m[1]); continue; }
        rbIvars.set(m[1], { mod });
        ivarProvenIdx.add(m.index);
      }
      // Loop 317: SAME-OPERAND `||` fallback on an ivar — the verbose
      // spelling of the Loop 305 `||=` memoization idiom:
      //   @client = @client || Stripe::StripeClient.new(key)
      // Same ruling as the local-variable form above: the backreference
      // forces operand ≡ target, so the field is either the cached value or
      // a proven construction. Proofs feed ivarProvenIdx so the file-level
      // ambiguity guard does not drop its own evidence. The keyword `or`
      // spelling never binds (low precedence parses as `(@c = @c) or …`).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*@([a-z_]\\w*)\\s*=\\s*@\\1\\s*\\|\\|\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint a field (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: not the client (Loop 337)
        const prev = rbIvars.get(m[1]);
        if (prev && prev.mod !== mod) { rbIvars.delete(m[1]); continue; }
        rbIvars.set(m[1], { mod });
        ivarProvenIdx.add(m.index);
      }
      // Loop 314: BOTH-ARMS ternary construction on an ivar — same ruling
      // as the local-variable form above (rbTernaryBind), target spelling
      // `@ivar`. Ternary proofs feed ivarProvenIdx so the file-level
      // ambiguity guard below does not drop its own evidence; a non-proven
      // reassignment elsewhere still drops the field (never guess).
      for (const m of text.matchAll(new RegExp(`^[ \\t]*@([a-z_]\\w*)\\s*=\\s*(?:\\w\\?(?=[ \\t])|[^?;\\n])*?\\?[ \\t]+(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*\\(`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint a field (Loop 298)
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '\n') break; // consequent must close on the same line — honest skip
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue;
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        if (text[i] !== ':') continue;
        const nl = text.indexOf('\n', i + 1);
        const rest = text.slice(i + 1, nl === -1 ? text.length : nl);
        if (!new RegExp(`^[ \\t]*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\s*\\(`).test(rest)) continue; // else arm must also construct — AST track
        const prev = rbIvars.get(m[1]);
        if (prev && prev.mod !== mod) { rbIvars.delete(m[1]); continue; }
        rbIvars.set(m[1], { mod });
        ivarProvenIdx.add(m.index);
      }
      // Loop 360: chained assignment with an @ivar target — the Ruby cell
      // of the field-target chained matrix (PHP $this-> Loop 352 / Python
      // self. Loop 358 / JS this. Loop 359), composing the Loop 350/355
      // chained ruling (Ruby chained assignment binds EVERY target to the
      // same RHS value — language semantics, not chain-shape guessing)
      // with the Loop 211 ivar proof (same RHS, only the target spelling
      // changes). Three spellings, all probe-verified honest misses before
      // this loop (every consumer chain on both names invisible):
      //   @sc = client = Stripe::StripeClient.new(key)   (field-first)
      //   client = @sc = Stripe::StripeClient.new(key)   (var-first)
      //   @sc = @alias = Stripe::StripeClient.new(key)   (field-to-field)
      // Rules carried verbatim from Loop 350/355: two targets only (3+ is
      // a structural fail — the slot after the second `=` must be the
      // proven constant root — honest skip, AST track); `=(?![=~])` on
      // both operators rejects comparison / match lookalikes; the trailer
      // set mirrors the PLAIN matcher (paren, paren-less EOL w/ optional
      // comment, kwarg/symbol/string starter, ENV argument, and
      // value-preserving freeze/dup/clone); bindingProseGuard +
      // rbCtorTrailerOk apply unchanged. Variable slots admit locals AND
      // constants (Loop 333). Field proofs at statement start feed
      // ivarProvenIdx so the file-level ambiguity guard below does not
      // drop its own evidence; a mid-line field write (var-first form,
      // second slot of field-to-field) is invisible to that guard by
      // construction (statement anchor), matching the Loop 358/359
      // treatment. Derived trailers (`.new(k).charges`) bind neither name.
      const rbChainTrailer = `\\.new\\s*(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|(?:\\.(?:freeze|dup|clone))+[ \\t]*(?:#.*)?$|[ \\t]*(?:#.*)?$)`;
      // field-first: @field = var = Const.new...
      for (const m of text.matchAll(new RegExp(`^[ \\t]*@([a-z_]\\w*)\\s*=(?![=~])\\s*([A-Za-z_]\\w*)\\s*=(?![=~])\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*${rbChainTrailer}`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 337)
        const prev = rbIvars.get(m[1]);
        if (prev && prev.mod !== mod) { rbIvars.delete(m[1]); continue; }
        rbIvars.set(m[1], { mod });
        ivarProvenIdx.add(m.index);
        rbInstances.set(m[2], { mod });
      }
      // var-first: var = @field = Const.new...
      for (const m of text.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)\\s*=(?![=~])\\s*@([a-z_]\\w*)\\s*=(?![=~])\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*${rbChainTrailer}`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 337)
        rbInstances.set(m[1], { mod });
        const prev = rbIvars.get(m[2]);
        if (prev && prev.mod !== mod) { rbIvars.delete(m[2]); continue; }
        rbIvars.set(m[2], { mod });
      }
      // field-to-field: @field = @field2 = Const.new...
      for (const m of text.matchAll(new RegExp(`^[ \\t]*@([a-z_]\\w*)\\s*=(?![=~])\\s*@([a-z_]\\w*)\\s*=(?![=~])\\s*(?:::)?${er}(?:::[A-Za-z_]\\w*)*${rbChainTrailer}`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
        if (!rbCtorTrailerOk(m)) continue; // derived-object trailer: neither name holds the client (Loop 337)
        const prev1 = rbIvars.get(m[1]);
        if (prev1 && prev1.mod !== mod) { rbIvars.delete(m[1]); }
        else { rbIvars.set(m[1], { mod }); ivarProvenIdx.add(m.index); }
        const prev2 = rbIvars.get(m[2]);
        if (prev2 && prev2.mod !== mod) { rbIvars.delete(m[2]); }
        else { rbIvars.set(m[2], { mod }); }
      }
    }
    // Loop 360: the chained-ivar passes above may mint NEW local/constant
    // instances (the variable slot of a field/var chain) after the earlier
    // rbInstances -> roots sync ran — re-sync so those consumer chains root.
    for (const [name, info] of rbInstances) {
      if (!roots.has(name)) roots.set(name, { mod: info.mod, ctor: null, named: false });
    }
    if (rbIvars.size) {
      // Loop 327: bare `@f = nil` placeholder whitelist — the standard
      // initialize() init that pairs with a `||=` (or guarded) lazy-init.
      // nil carries zero construction ambiguity ("not built yet", never
      // "built as something else"), so it may keep the memoized proof.
      // Strictly plain `=` only (compound ops imply an unknown prior value
      // and still drop); RHS must be a bare nil literal to end of line
      // (trailing `#` comment allowed). Conditionals and calls never match
      // and drop as before — mirror of the Loop 324 (Python None) /
      // 325 (JS null) / 326 (PHP null) rulings.
      for (const m of text.matchAll(/^[ \t]*@([a-z_]\w*)\s*(?:\|\||&&|[+\-*/%|&^])?=(?!=|~)/gm)) {
        if (!rbIvars.has(m[1]) || ivarProvenIdx.has(m.index)) continue;
        if (!/[|&+\-*/%^]/.test(m[0])) {
          const nl = text.indexOf('\n', m.index);
          const rhs = text.slice(m.index + m[0].length, nl === -1 ? undefined : nl).trim();
          if (/^nil\s*(?:#.*)?$/.test(rhs)) continue; // bare nil placeholder: keep the proof
        }
        rbIvars.delete(m[1]);
      }
    }
  }

  // Loop 332: Ruby memoized ACCESSOR methods — the documented stripe-ruby
  // lazy-init idiom consumed through the METHOD name, not the ivar:
  //   def client
  //     @client ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  //   end
  //   client.charges.create(...)
  // The ivar pass above proves `@client`, but the consumer chain roots on
  // `client` (a paren-less zero-arg method call), so every chain in the
  // file stayed invisible (probe loop332: s1/s2 honest miss). Binding
  // ruling: a Ruby method returns its LAST expression; when the def body
  // is exactly the memoized `||=` construction (multi-line form with the
  // construction line immediately followed by `end`, or the single-line
  // `def name; @x ||= Const.new(...); end` form), the method's return
  // value is either the cached instance or a fresh proven construction —
  // binding strength equals a plain local assignment. Strictness:
  //   - def header must be parameter-less (`def name(key)` never binds —
  //     bare `name.chain` would not even be a valid zero-arg call);
  //   - method names ending in `?`/`!` are excluded (the chain grammar
  //     cannot root on them anyway);
  //   - intermediate body lines (logging before the ||=) are an honest
  //     skip — the construction must be the def's first and last statement
  //     so the return value is structurally the ivar (AST track otherwise);
  //   - ambiguity guard: a second `def <name>` anywhere in the file, or
  //     any local assignment to the same name (shadowing), drops the
  //     accessor entirely — never guess;
  //   - bindingProseGuard rejects heredoc/=begin lookalikes on the def;
  //     consumer-side prose is already covered by the Loop 328
  //     rbCodePosition guard on generic chain dispatch;
  //   - a name already proven as a local instance keeps the local proof
  //     (roots.has check below) — no double claim.
  // Loop 343: constructor trailing-chain adjudication (the Loop 337 ruling
  // applied to this pass). Both accessor matchers swallowed whatever followed
  // the balanced close paren of the construction (`[^\n]*` in the multi-line
  // form; the greedy `[^\n]*\)` in the single-line form), so
  //   def capi; @c ||= Stripe::StripeClient.new(k).refunds.list(limit: 1); end
  // bound `capi` as the CLIENT while the method actually returns a derived
  // RESOURCE (probe-verified FALSE ATTRIBUTION: pa/pe emitted wrong client.*
  // surfaces). Ruling: after the balanced close of the ctor's argument list,
  // only value-identity chains (`.freeze`/`.dup`/`.clone`) may follow on the
  // construction line; any other `.method` trailer means the accessor returns
  // a derived object => drop (AST track). Paren-less argument spellings are
  // exempt by grammar: in `X.new ENV["K"].charges` the chain attaches to the
  // ARGUMENT and the expression value is still the client.
  const rbAccessorCtorTailOk = (constructionLine) => {
    const at = constructionLine.indexOf('.new');
    if (at === -1) return true; // defensive: matcher guarantees a ctor
    const seg = constructionLine.slice(at + 4);
    const pm = seg.match(/^[ \t]*\(/);
    if (!pm) return true; // paren-less: expression value stays the client
    let i = pm[0].length;
    let depth = 1;
    while (i < seg.length && depth > 0) {
      const ch = seg[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth !== 0) return true; // no same-line close: matcher shape forbids
    return /^(?:\.(?:freeze|dup|clone)\b)*[ \t]*(?:;[ \t]*end\b|#|$)/.test(seg.slice(i));
  };
  const rbAccessors = new Map(); // methodName -> { mod }
  if (rbConsts.length) {
    for (const { mod, root } of rbConsts) {
      const er = escapeRe(root);
      const trailer = `(?:\\(|[ \\t]+(?:[a-z_]\\w*:(?!:)|:[a-z_]\\w*|['"]|ENV(?:\\[|\\.fetch\\())|[ \\t]*(?:#.*)?$)`;
      // multi-line form: def header, memoized construction line, `end`.
      for (const m of text.matchAll(new RegExp(`^[ \\t]*def[ \\t]+(?:self\\.)?([a-z_]\\w*)[ \\t]*(?:#.*)?\\n([ \\t]*@[a-z_]\\w*[ \\t]*\\|\\|=[ \\t]*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new[ \\t]*${trailer}[^\\n]*)\\n[ \\t]*end\\b`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
        if (!rbAccessorCtorTailOk(m[2])) continue; // derived-object trailer: not the client (Loop 343)
        const prev = rbAccessors.get(m[1]);
        if (prev && prev.mod !== mod) { rbAccessors.delete(m[1]); continue; }
        rbAccessors.set(m[1], { mod });
      }
      // single-line form: def name; @x ||= Const.new(...); end
      for (const m of text.matchAll(new RegExp(`^[ \\t]*def[ \\t]+(?:self\\.)?([a-z_]\\w*)[ \\t]*;[ \\t]*(@[a-z_]\\w*[ \\t]*\\|\\|=[ \\t]*(?:::)?${er}(?:::[A-Za-z_]\\w*)*\\.new\\([^\\n]*\\)[ \\t]*;[ \\t]*end)[ \\t]*(?:#.*)?$`, 'gm'))) {
        if (bindingProseGuard(m)) continue; // prose container: never mint (Loop 298)
        if (!rbAccessorCtorTailOk(m[2])) continue; // derived-object trailer: not the client (Loop 343)
        const prev = rbAccessors.get(m[1]);
        if (prev && prev.mod !== mod) { rbAccessors.delete(m[1]); continue; }
        rbAccessors.set(m[1], { mod });
      }
    }
    if (rbAccessors.size) {
      // Ambiguity guard 1: a second definition of the same method name
      // anywhere in the file (monkey-patch / conditional redefinition)
      // makes the return value unprovable — drop.
      const defCounts = new Map();
      for (const m of text.matchAll(/^[ \t]*def[ \t]+(?:self\.)?([a-z_]\w*)/gm)) {
        defCounts.set(m[1], (defCounts.get(m[1]) || 0) + 1);
      }
      for (const name of [...rbAccessors.keys()]) {
        if ((defCounts.get(name) || 0) > 1) rbAccessors.delete(name);
      }
      // Ambiguity guard 2: any local assignment to the accessor name
      // (plain, compound, or memoized — never `==` comparisons) shadows
      // the method in that scope — attribution unprovable, drop.
      for (const m of text.matchAll(/^[ \t]*([a-z_]\w*)[ \t]*(?:\|\||&&|[+\-*/%|&^])?=(?!=|~|>)/gm)) {
        if (rbAccessors.has(m[1])) rbAccessors.delete(m[1]);
      }
      for (const [name, info] of rbAccessors) {
        if (!roots.has(name)) roots.set(name, { mod: info.mod, ctor: null, named: false });
      }
    }
  }

  // PHP: use-statement class bindings and $variable instances. Every proof is
  // line-anchored PHP syntax (never chain shape):
  //   use Stripe\StripeClient;              -> class StripeClient bound
  //   use Stripe\Service\{A, B as C};       -> A and C bound (group form)
  //   $stripe = new StripeClient(...);      -> $stripe joins as chain root
  //   $stripe->customers->create(...)       -> sdk-call client.customers.create
  //   \Stripe\Charge::create(...)           -> sdk-call client.Charge.create
  //   BoundClass::method(...)               -> sdk-call via the use proof
  // Relative Ns\A::m() references (no leading backslash) ARE handled, but
  // only in files that declare NO namespace: per the PHP spec, relative names
  // there resolve from the global namespace, so the reference is exactly the
  // fully-qualified one. That absence is a whole-file line-anchored fact
  // (single grep for a `namespace` statement) — no scope tracking involved.
  // Files that declare any namespace keep relative refs on the AST track.
  // Deliberately NOT handled (AST track): dynamic class names, instances
  // from method returns.
  const phpGlobalNs = isPhp && !/^\s*namespace\s+[A-Za-z_]/m.test(text);
  // Loop 299: the PHP binding matchers below run over the MASKED text
  // (phpMaskLine pre-pass) — comment/string/heredoc lookalikes can no
  // longer mint phantom $var / $this->field bindings. Masking is
  // offset-preserving, so match indices (phpProvenIdx ambiguity guard)
  // keep their raw-text meaning.
  const phpScanText = isPhp && maskedLines ? maskedLines.join('\n') : text;
  const phpClasses = new Map(); // className -> { mod, segs }  (segs = path after root ns)
  const phpVars = new Map();    // $varName -> { mod }
  const phpThisFields = new Map(); // fieldName -> { mod }  ($this->field = new Proven(...))
  const phpTypedFields = new Map(); // fieldName -> { mod }  (typed property / promoted ctor prop — Loop 205)
  if (phpNs.length) {
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      // use Ns\A\B;  /  use Ns\A\B as C;
      for (const m of phpScanText.matchAll(new RegExp(`^[ \\t]*use\\s+${en}\\\\([A-Za-z_\\\\][\\w\\\\]*?)(?:\\s+as\\s+([A-Za-z_]\\w*))?\\s*;`, 'gm'))) {
        const segs = m[1].split('\\');
        const cls = m[2] || segs[segs.length - 1];
        if (/^[A-Za-z_]\w*$/.test(cls)) phpClasses.set(cls, { mod, segs });
      }
      // use Ns\Path\{A, B as C};  (group form)
      for (const m of phpScanText.matchAll(new RegExp(`^[ \\t]*use\\s+${en}\\\\([\\w\\\\]*?)\\{([^}]*)\\}\\s*;`, 'gm'))) {
        const prefix = m[1].split('\\').filter(Boolean);
        for (const part of m[2].split(',')) {
          const toks = part.trim().split(/\s+as\s+/);
          const leaf = (toks[0] || '').trim();
          const cls = (toks[1] || leaf.split('\\').pop() || '').trim();
          if (!leaf || !/^[A-Za-z_]\w*$/.test(cls)) continue;
          phpClasses.set(cls, { mod, segs: [...prefix, ...leaf.split('\\')] });
        }
      }
    }
    // Loop 339: PHP constructor trailing-chain adjudication — the PHP mirror
    // of the Ruby (Loop 337) and JS/Python (Loop 338) rulings. PHP 8.4 allows
    // member access on a `new` expression without wrapping parens, so
    // `$sc = new StripeClient($k)->charges;` compiles and binds $sc to a
    // DERIVED resource, not the client — probe-verified false attribution
    // across local plain / `??=` sugar / same-operand fallback / ternary
    // alternate arm / $this->field holders. Ruling: walk the constructor
    // call's balanced parens (crossing lines), then the next non-space
    // characters must NOT start a member access (`->` / `?->`). PHP has no
    // value-identity trailer (no `.freeze` analogue), so any arrow trailer
    // drops the binding (AST track). The pre-8.4 parenthesized spelling
    // (`(new X($k))->prop`) never reached these matchers (`=\s*new` refuses
    // the leading paren) and stays an honest skip. An unbalanced walk keeps
    // historical behavior; the walk runs over phpScanText, so string-literal
    // parens are already blanked by phpMaskLine.
    // Loop 340: `outerParen` extends the same ruling to the pre-8.4
    // parenthesized spelling (`$sc = (new StripeClient($k));`) — the ONLY
    // way to write member access on a `new` expression before PHP 8.4, so
    // the bulk of existing code uses it. The wrapping parens change nothing
    // about what the variable holds: with no trailer after the outer close,
    // the variable IS the client; with an arrow trailer after the outer
    // close (`(new X($k))->charges`), it holds a derived resource and the
    // binding drops — exactly the bare-form ruling shifted one paren out.
    // For the paren form an unbalanced walk (or an outer paren that does
    // not close right after the ctor call) returns false, not true: the
    // expression continues past the construction, so the binding is
    // unproven (honest skip, never mis-attributed).
    const phpCtorTrailerOk = (idx, outerParen = false) => {
      let i = idx;
      let depth = 1;
      while (i < phpScanText.length && depth > 0) {
        const ch = phpScanText[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      if (depth !== 0) return outerParen ? false : true; // unbalanced: bare form keeps historical behavior; paren form is unproven
      while (i < phpScanText.length && (phpScanText[i] === ' ' || phpScanText[i] === '\t')) i++;
      if (outerParen) {
        if (phpScanText[i] !== ')') return false; // outer paren must close immediately after the ctor call — anything else is unproven
        i++;
        while (i < phpScanText.length && (phpScanText[i] === ' ' || phpScanText[i] === '\t')) i++;
      }
      if (phpScanText[i] === '-' && phpScanText[i + 1] === '>') return false; // derived-object trailer
      if (phpScanText[i] === '?' && phpScanText[i + 1] === '-' && phpScanText[i + 2] === '>') return false; // nullsafe trailer
      return true;
    };
    // $var = new BoundClass(...)  — instance proof through the use binding.
    // Loop 330: the null-coalescing-assignment sugar (`$sc ??= new
    // StripeClient($k)`, PHP 7.4+) also binds — the memoized lazy-init
    // spelling on LOCALS (include-based legacy scripts, WordPress plugin
    // bootstrap files). Mirrors the Ruby bare-local `||=` ruling (Loop 329)
    // and the JS local `??=` binding (Loop 198): with a proven-class `new`
    // RHS, `??=` either constructs or keeps a previously constructed value,
    // so binding strength equals plain `=`. Only `??=` is accepted (the
    // optional group admits exactly `??`); no other compound op guarantees
    // construction. Prose lookalikes are structurally dead — phpScanText is
    // pre-masked (comments/strings/heredocs blanked by phpMaskLine).
    for (const [cls, info] of phpClasses) {
      for (const m of phpScanText.matchAll(new RegExp(`\\$([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*new\\s+${escapeRe(cls)}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpVars.set(m[1], { mod: info.mod });
      }
    }
    // $var = new \Ns\Class(...) (fully-qualified) or new Ns\Class(...)
    // (relative, global-namespace files only) — the reference itself is the
    // proof, no use statement needed. Loop 330: `??=` sugar accepted here
    // too (same ruling as the use-bound form above).
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      for (const m of phpScanText.matchAll(new RegExp(`\\$([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*new\\s+${lead}${en}(?:\\\\[A-Za-z_]\\w*)+\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpVars.set(m[1], { mod });
      }
    }
    // Loop 351: chained assignment spelling of the same proof —
    //   $sc = $client = new StripeClient($key);
    // PHP assignment is an expression: the inner `$client = new X($k)`
    // evaluates to the constructed client and the outer target binds the
    // same value — BOTH names hold the client (language semantics, not
    // chain-shape guessing). The plain matchers above already catch the
    // INNER target (they are not line-anchored), so before this pass the
    // outer name's whole consumer chain was invisible — an honest miss of
    // the alias+primary / module-singleton-with-two-exports idiom. Two
    // targets only (3+ chains structurally fail — the inner target must
    // be followed directly by `= new`; extra leading targets stay an
    // honest skip, AST track — a lookbehind refuses a match whose first
    // target is itself preceded by `=`, so `$a = $b = $c = new X()` never
    // partially binds the inner pair). `=(?!=)` on both operators rejects
    // comparison lookalikes (`$a == $b == new X()` — a boolean, never a
    // client). No `??=` slot on either operator: chained null-coalescing
    // assignment has different short-circuit semantics (the outer target
    // may keep a PREVIOUS unrelated value), so only plain `=` carries the
    // proof. Trailer walk as usual — a derived trailer means NEITHER name
    // holds the client. Prose lookalikes are dead (phpScanText is
    // pre-masked); the paren-wrapped ctor spelling inside a chain
    // (`$a = $b = (new X($k));`) is rare and stays an honest skip
    // (recorded candidate).
    for (const [cls, info] of phpClasses) {
      for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$([A-Za-z_]\\w*)\\s*=(?!=)\\s*new\\s+${escapeRe(cls)}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: neither name holds the client (Loop 351)
        phpVars.set(m[1], { mod: info.mod });
        phpVars.set(m[2], { mod: info.mod });
      }
    }
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$([A-Za-z_]\\w*)\\s*=(?!=)\\s*new\\s+${lead}${en}(?:\\\\[A-Za-z_]\\w*)+\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: neither name holds the client (Loop 351)
        phpVars.set(m[1], { mod });
        phpVars.set(m[2], { mod });
      }
    }
    // Loop 340: the pre-8.4 PARENTHESIZED construction spelling —
    //   $sc = (new StripeClient($key));
    //   $this->sc = (new \Stripe\StripeClient($key));
    // Before PHP 8.4 wrapping parens were mandatory for member access on a
    // `new` expression, so codebases carry both the trailer form (a derived
    // resource — never the client) and the bare wrap (defensive style /
    // editor autoformat — exactly the client). The `=\s*new` matchers above
    // structurally refuse the leading paren, which made this an honest skip
    // until now. The trailer walk (outerParen mode) requires the outer paren
    // to close immediately after the ctor call and then refuses any arrow
    // trailer — `(new X($k))->charges` and `(new X($k))?->charges` drop
    // (derived resource), `$sc = (new X($k));` binds. An outer paren that
    // does not close right after the construction (`(new X($k) && $flag)`)
    // is not a bare wrap — the expression value is unproven, refuse. Non-
    // arrow trailers after the close (string concat etc.) mirror the bare-
    // form Loop 339 behavior: accepted as-is (the walk only adjudicates
    // member access; a concat result is a string and never re-matches the
    // chain grammar as a client root — recorded honest limitation shared
    // with the bare form). `??=` sugar carries the same proof (Loop 330
    // ruling). Prose lookalikes are dead — matchers run over phpScanText
    // (phpMaskLine pre-masked).
    for (const [cls, info] of phpClasses) {
      for (const m of phpScanText.matchAll(new RegExp(`\\$([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*\\(\\s*new\\s+${escapeRe(cls)}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived-object trailer after the outer close (Loop 340)
        phpVars.set(m[1], { mod: info.mod });
      }
    }
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      for (const m of phpScanText.matchAll(new RegExp(`\\$([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*\\(\\s*new\\s+${lead}${en}(?:\\\\[A-Za-z_]\\w*)+\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived-object trailer after the outer close (Loop 340)
        phpVars.set(m[1], { mod });
      }
    }
    // Loop 341: DIRECT INLINE constructor chain consumption — construct and
    // consume in one expression, no variable:
    //   (new StripeClient($k))->tax_ids->create([...]);      pre-8.4 wrap
    //   new StripeClient($k)->exchange_rates->retrieve(...); 8.4 paren-less
    // The class reference is the proof (use binding / FQ / global-relative,
    // exactly the binding matchers' proof); the same-line balanced-paren walk
    // makes the read provable without AST. A trailing CALL paren is required
    // so bare property reads never mint a surface — this is the PHP twin of
    // the JS/Python inlineChainAfter pass (Loop 213). Rulings carried over:
    //   - wrapped mode requires the outer paren to close immediately after
    //     the ctor call (Loop 340) — `($flag && new X($k))->...` is an
    //     expression whose value is unproven, silent;
    //   - multi-line argument lists stay on the AST track (the closing paren
    //     is not line-anchored evidence), same as inlineChainAfter;
    //   - assignment of a chain-call RESULT emits the call but never binds
    //     the variable (the binding matchers above refuse the trailer —
    //     Loop 339/340) — API data is not the client;
    //   - nullsafe segments (`?->`) resolve identically (PHP 8.0+ grammar);
    //   - prose lookalikes are structurally dead (phpScanText pre-masked).
    // The paren-less regex also fires inside wrapped spellings and plain
    // binding lines, but the chain-call requirement rejects both (`)` / `;`
    // follows the ctor close) — no double emit, no phantom surface.
    const phpInlineCtorChain = (ctorRe, mod, wrapped) => {
      const re = wrapped
        ? new RegExp(`\\(\\s*new\\s+${ctorRe}\\s*\\(`, 'g')
        : new RegExp(`\\bnew\\s+${ctorRe}\\s*\\(`, 'g');
      for (const m of phpScanText.matchAll(re)) {
        let i = m.index + m[0].length, depth = 1, cross = false;
        while (i < phpScanText.length && depth > 0) {
          const ch = phpScanText[i];
          if (ch === '\n') { cross = true; break; } // multi-line args: AST track
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (cross || depth !== 0) continue;
        if (wrapped) {
          while (phpScanText[i] === ' ' || phpScanText[i] === '\t') i++;
          if (phpScanText[i] !== ')') continue; // outer paren is an expression, not a bare wrap — unproven
          i++;
        }
        const nl = phpScanText.indexOf('\n', i);
        const rest = phpScanText.slice(i, nl === -1 ? phpScanText.length : nl);
        const cm = rest.match(/^[ \t]*((?:\?{0,1}->[A-Za-z_]\w*)+)[ \t]*\(/);
        if (!cm) continue; // no same-line chain call — silent (property read / bare ctor)
        const segs = cm[1].replace(/^\?{0,1}->/, '').split(/\?->|->/);
        const ln = phpScanText.slice(0, m.index).split('\n').length;
        calls.push({ module: mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: ln, snippet: lines[ln - 1].trim().slice(0, 200) });
      }
    };
    for (const [cls, info] of phpClasses) {
      phpInlineCtorChain(escapeRe(cls), info.mod, true);
      phpInlineCtorChain(escapeRe(cls), info.mod, false);
    }
    for (const { mod, ns } of phpNs) {
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      const ctorRe = `${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`;
      phpInlineCtorChain(ctorRe, mod, true);
      phpInlineCtorChain(ctorRe, mod, false);
    }
    // Loop 312: BOTH-ARMS ternary construction — the test/live key idiom in
    // PHP spelling, mirroring the JS (Loop 304) and Python (Loop 311)
    // rulings:
    //   $sc = $isTest ? new StripeClient($testKey) : new StripeClient($liveKey);
    // Binding proof: whichever arm wins, the variable holds a construction
    // from the proven class reference. Restrictions mirror Loop 304 exactly:
    // the consequent's call must close on the SAME line (balanced-paren
    // walk; multi-line arg lists are an honest skip), and the alternate must
    // itself start with `new <ProvenClass>(` — a `: null` / `: makeFake()`
    // else arm leaves the variable unproven and stays AST track. The `?`
    // must not be `??` (null-coalescing), `?->` (nullsafe), or `?:` (Elvis
    // — its truthy arm is the condition, not a construction; separate
    // ruling, AST track for now): `\?(?![?:>-])` rejects all three. The
    // CONDITION segment may itself contain nullsafe property reads
    // (`$cfg?->flag ? new X(...) : new X(...)`, Loop 313): `(?:\?->|[^?;\n])*`
    // admits `?->` pairs inside the condition while still refusing any other
    // bare `?` there, so the ternary `?` we anchor on is unambiguous. Prose
    // lookalikes are structurally dead here — these matchers run over
    // phpScanText, where phpMaskLine has already blanked comments, strings,
    // and heredocs (probe e verified silent). The $this->field form feeds
    // phpProvenIdx so the plain-`=` ambiguity guard does not unbind its own
    // proof.
    const phpTernaryBind = (ctorRe, mod) => {
      const forms = [
        { re: new RegExp(`\\$([A-Za-z_]\\w*)\\s*=\\s*(?:\\?->|[^?;\\n])*\\?(?![?:>-])\\s*new\\s+${ctorRe}\\s*\\(`, 'g'), field: false },
        { re: new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=\\s*(?:\\?->|[^?;\\n])*\\?(?![?:>-])\\s*new\\s+${ctorRe}\\s*\\(`, 'g'), field: true },
      ];
      const altRe = new RegExp(`^\\s*new\\s+${ctorRe}\\s*\\(`);
      for (const { re, field } of forms) {
        for (const m of phpScanText.matchAll(re)) {
          let i = m.index + m[0].length; // just past the consequent's opening paren
          let depth = 1;
          while (i < phpScanText.length && depth > 0) {
            const ch = phpScanText[i];
            if (ch === '\n') break; // consequent must close on the same line — honest skip
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            i++;
          }
          if (depth !== 0) continue;
          while (i < phpScanText.length && (phpScanText[i] === ' ' || phpScanText[i] === '\t')) i++;
          if (phpScanText[i] !== ':') continue;
          const nl = phpScanText.indexOf('\n', i + 1);
          const rest = phpScanText.slice(i + 1, nl === -1 ? phpScanText.length : nl);
          const am = rest.match(altRe);
          if (!am) continue; // else arm must also construct — otherwise AST track
          if (!phpCtorTrailerOk(i + 1 + am.index + am[0].length)) continue; // derived-object trailer on the alternate arm (Loop 339)
          if (field) { phpThisFields.set(m[1], { mod }); phpTernaryProvenIdx.push(m.index); }
          else phpVars.set(m[1], { mod });
        }
      }
    };
    const phpTernaryProvenIdx = [];
    for (const [cls, info] of phpClasses) phpTernaryBind(escapeRe(cls), info.mod);
    for (const { mod, ns } of phpNs) {
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      phpTernaryBind(`${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`, mod);
    }
    // Loop 319: SAME-OPERAND fallback construction — the memoized-singleton
    // idiom in PHP spelling, mirroring the Ruby `sc = sc || X.new` (Loop 317)
    // and Python `x = x or X(k)` (Loop 315) rulings:
    //   $sc = $sc ?? new StripeClient($k);       (null-coalescing)
    //   $sc = $sc ?: new StripeClient($k);       (Elvis, truthiness check)
    //   $this->f = $this->f ?? new StripeClient($k);   (field verbose form)
    // Binding proof is structural: the regex backreference forces the
    // fallback operand to be THE SAME name as the assignment target, so
    // whichever side wins, the bound name is either its own cached value or
    // a construction from the proven class reference. A different operand
    // (`$sc = $other ?? new X(`) fails the backreference and stays on the
    // AST track; a call-expression operand (`getCached() ?? ...`) never
    // matches (identifier grammar only — idempotence not guaranteed, honest
    // skip). The `??=` sugar on LOCALS binds since Loop 330 (via the
    // instance-proof pass above — overturns the Loop 306 deferral, mirroring
    // the Ruby bare-local `||=` ruling of Loop 329). Prose lookalikes
    // are structurally dead — matchers run over phpScanText where
    // phpMaskLine has blanked comments, strings, and heredocs. Field proofs
    // feed phpProvenIdx (via the same deferred array as the ternary pass) so
    // the plain-`=` ambiguity guard keeps its own evidence; the RHS
    // `$this->f ??` re-read never trips the guard (guard only matches `=`).
    const phpFallbackBind = (ctorRe, mod) => {
      for (const m of phpScanText.matchAll(new RegExp(`\\$([A-Za-z_]\\w*)\\s*=\\s*\\$\\1\\s*(?:\\?\\?|\\?:)\\s*new\\s+${ctorRe}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpVars.set(m[1], { mod });
      }
      for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=\\s*\\$this\\s*->\\s*\\1\\s*(?:\\?\\?|\\?:)\\s*new\\s+${ctorRe}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpThisFields.set(m[1], { mod });
        phpTernaryProvenIdx.push(m.index);
      }
    };
    for (const [cls, info] of phpClasses) phpFallbackBind(escapeRe(cls), info.mod);
    for (const { mod, ns } of phpNs) {
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      phpFallbackBind(`${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`, mod);
    }
    // Class-property constructor bindings (PHP): the service-class idiom —
    //   public function __construct($k) { $this->stripe = new StripeClient($k); }
    //   ... $this->stripe->charges->create(...)
    // Exactly the JS `this.<field> = new Binding(...)` proof (Loop 203) in
    // PHP spelling: a `$this->field = new <proven class>(` assignment through
    // a use binding (or a fully-qualified/global-relative class reference).
    // Nullsafe writes (`$this?->f =`) are invalid PHP, so only `->` is
    // collected. Scope is honestly file-level, not class-level, so the same
    // ambiguity guard applies: if the same field name is ALSO assigned
    // anywhere in the file from a non-proven RHS, the field is dropped —
    // never guess which class a `$this->` chain belongs to. Consumption
    // requires field + at least one member + method (two arrow segments after
    // the field), so `$this->log(...)` and `$this->stripe->ping(...)`
    // (attribution too thin) never bind.
    // Loop 306: the null-coalescing-assignment spelling (`$this->client ??=
    // new StripeClient($k)`, PHP 7.4+) is the standard memoized-getter idiom
    // (Laravel service classes lazily init shared clients exactly this way).
    // Semantically it means "construct, or keep the already-constructed
    // value" — when the RHS is a proven construction, the binding strength
    // equals plain `=` (same ruling as Ruby `||=`, Loop 305). Only `??=` is
    // accepted; no other augmented op guarantees construction. Local
    // `$var ??=` binds since Loop 330 via the instance-proof pass above
    // (overturns the Loop 306 deferral — Ruby bare-local `||=` parity).
    const phpProvenIdx = new Set();
    for (const idx of phpTernaryProvenIdx) phpProvenIdx.add(idx); // Loop 312: ternary field proofs are their own evidence
    for (const [cls, info] of phpClasses) {
      for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*new\\s+${escapeRe(cls)}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpThisFields.set(m[1], { mod: info.mod });
        phpProvenIdx.add(m.index);
      }
    }
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*new\\s+${lead}${en}(?:\\\\[A-Za-z_]\\w*)+\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: not the client (Loop 339)
        phpThisFields.set(m[1], { mod });
        phpProvenIdx.add(m.index);
      }
    }
    // Loop 353: paren-wrapped construction with a $this->field target — the
    // field twin of the Loop 340 var-target ruling:
    //   $this->sc = (new StripeClient($key));
    //   $this->sc ??= (new \Stripe\StripeClient($key));
    // Pre-8.4 codebases wrap `new` in parens (mandatory for member access
    // before PHP 8.4; defensive style / editor autoformat keeps the bare
    // wrap around plain constructions too). The plain field matchers above
    // structurally refuse the leading paren, which made this an honest
    // miss (probe-loop353). Ruling carries over verbatim: the outer paren
    // must close immediately after the ctor call (outerParen trailer walk),
    // then any arrow trailer drops — `(new X($k))->charges` is a derived
    // resource, never the client; an outer paren that does not close right
    // after the construction (`(new X($k) && $flag)`) leaves the expression
    // value unproven, refuse. `??=` sugar carries the same proof (Loop
    // 330/340). Field binds feed phpProvenIdx at the match start so the
    // ambiguity guard never unbinds its own evidence. The CHAINED
    // paren-wrap spelling (`$a = $this->f = (new X($k))`) stays a recorded
    // candidate (Loop 351 note) — this pass is the plain form only.
    for (const [cls, info] of phpClasses) {
      for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*\\(\\s*new\\s+${escapeRe(cls)}\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived-object trailer after the outer close (Loop 353)
        phpThisFields.set(m[1], { mod: info.mod });
        phpProvenIdx.add(m.index);
      }
    }
    for (const { mod, ns } of phpNs) {
      const en = escapeRe(ns);
      const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
      for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*(?:\\?\\?)?=\\s*\\(\\s*new\\s+${lead}${en}(?:\\\\[A-Za-z_]\\w*)+\\s*\\(`, 'g'))) {
        if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived-object trailer after the outer close (Loop 353)
        phpThisFields.set(m[1], { mod });
        phpProvenIdx.add(m.index);
      }
    }
    // Loop 352: chained assignment with $this->field targets — the field
    // spelling of the Loop 351 proof (`$sc = $client = new StripeClient($k)`).
    // PHP assignment is an expression, so in
    //   $this->sc = $client = new StripeClient($key);
    //   $sc = $this->client = new StripeClient($key);
    //   $this->primary = $this->alias = new StripeClient($key);
    // BOTH targets bind the constructed client (language semantics, not
    // chain-shape guessing). The plain matchers above already catch the
    // INNER target (they are not line-anchored — probe-loop352 verified),
    // so each pass here binds ONLY the OUTER target. Two targets only
    // (the inner target must be followed directly by `= new`; 3+ chains
    // structurally fail and the leading lookbehind refuses a partial
    // inner-pair match — honest skip, AST track). `=(?!=)` on both
    // operators rejects comparison lookalikes; no `??=` slot (chained
    // null-coalescing short-circuits — the outer target may keep a
    // previous unrelated value, only plain `=` carries the proof —
    // Loop 351 ruling). Field binds feed phpProvenIdx at the match start
    // (which is exactly where the ambiguity-guard regex anchors) so the
    // guard never unbinds its own evidence. The outer-var pass refuses a
    // literal `$this` target (invalid PHP; never mint a `this` pseudo-var).
    // Trailer walk as usual — a derived trailer means NEITHER name holds
    // the client (the inner plain matcher drops it independently). Prose
    // lookalikes are dead (phpScanText is pre-masked by phpMaskLine).
    {
      const phpChainFieldOuter = (ctorRe, mod) => {
        // field-outer / var-inner: $this->sc = $client = new X(
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$(?!this\\b)[A-Za-z_]\\w*\\s*=(?!=)\\s*new\\s+${ctorRe}\\s*\\(`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: neither name holds the client (Loop 352)
          phpThisFields.set(m[1], { mod });
          phpProvenIdx.add(m.index);
        }
        // field-outer / field-inner: $this->primary = $this->alias = new X(
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$this\\s*->\\s*[A-Za-z_]\\w*\\s*=(?!=)\\s*new\\s+${ctorRe}\\s*\\(`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: neither name holds the client (Loop 352)
          phpThisFields.set(m[1], { mod });
          phpProvenIdx.add(m.index);
        }
        // var-outer / field-inner: $sc = $this->client = new X(
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$(?!this\\b)([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$this\\s*->\\s*[A-Za-z_]\\w*\\s*=(?!=)\\s*new\\s+${ctorRe}\\s*\\(`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length)) continue; // derived-object trailer: neither name holds the client (Loop 352)
          phpVars.set(m[1], { mod });
        }
      };
      for (const [cls, info] of phpClasses) phpChainFieldOuter(escapeRe(cls), info.mod);
      for (const { mod, ns } of phpNs) {
        const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
        phpChainFieldOuter(`${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`, mod);
      }
    }
    // Loop 354: chained assignment with a PAREN-WRAPPED ctor — the Loop
    // 351/353 recorded candidate, composing two proven rulings:
    //   $sc = $client = (new StripeClient($key));
    //   $this->sc = $client = (new StripeClient($key));
    //   $sc = $this->client = (new \Stripe\StripeClient($key));
    //   $this->primary = $this->alias = (new StripeClient($key));
    // Pre-8.4 defensive style / editor autoformat wraps the ctor in parens
    // even inside a chained assignment. The chained matchers above (Loop
    // 351/352) structurally refuse the leading paren, so before this pass
    // the OUTER target's whole consumer chain was invisible — an honest
    // miss (probe-loop354). The INNER target is caught independently by
    // the Loop 340 (var) / Loop 353 (field) plain paren matchers (probes
    // verified), so each matcher here binds ONLY the outer target.
    // Rulings carry over verbatim: the outer paren must close immediately
    // after the ctor call (outerParen trailer walk — Loop 340), then any
    // arrow trailer drops (a derived resource — NEITHER name holds the
    // client; the inner paren matcher drops it via the same walk); a paren
    // that does not close right after the construction (`(new X($k) ?:
    // null)`) leaves the expression value unproven, refuse. Plain `=` on
    // both operators only — chained `??=` short-circuits and the outer
    // target may keep a previous unrelated value (Loop 351 ruling).
    // Two targets only (the leading lookbehind refuses a partial
    // inner-pair match on 3+ chains — honest skip, AST track). The
    // field-outer passes refuse a literal `$this` var-inner lookalike via
    // `(?!this\b)`; field binds feed phpProvenIdx at the match start so
    // the ambiguity guard never unbinds its own evidence. Prose
    // lookalikes are dead (phpScanText is pre-masked by phpMaskLine).
    {
      const phpChainParenOuter = (ctorRe, mod) => {
        const tail = `=(?!=)\\s*\\(\\s*new\\s+${ctorRe}\\s*\\(`;
        // var-outer / var-inner: $sc = $client = (new X($k))
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$(?!this\\b)([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$(?!this\\b)[A-Za-z_]\\w*\\s*${tail}`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived trailer / non-tight paren: outer name unproven (Loop 354)
          phpVars.set(m[1], { mod });
        }
        // field-outer / var-inner: $this->sc = $client = (new X($k))
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$(?!this\\b)[A-Za-z_]\\w*\\s*${tail}`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived trailer / non-tight paren: outer name unproven (Loop 354)
          phpThisFields.set(m[1], { mod });
          phpProvenIdx.add(m.index);
        }
        // var-outer / field-inner: $sc = $this->client = (new X($k))
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$(?!this\\b)([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$this\\s*->\\s*[A-Za-z_]\\w*\\s*${tail}`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived trailer / non-tight paren: outer name unproven (Loop 354)
          phpVars.set(m[1], { mod });
        }
        // field-outer / field-inner: $this->primary = $this->alias = (new X($k))
        for (const m of phpScanText.matchAll(new RegExp(`(?<!=[ \\t]*)\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=(?!=)\\s*\\$this\\s*->\\s*[A-Za-z_]\\w*\\s*${tail}`, 'g'))) {
          if (!phpCtorTrailerOk(m.index + m[0].length, true)) continue; // derived trailer / non-tight paren: outer name unproven (Loop 354)
          phpThisFields.set(m[1], { mod });
          phpProvenIdx.add(m.index);
        }
      };
      for (const [cls, info] of phpClasses) phpChainParenOuter(escapeRe(cls), info.mod);
      for (const { mod, ns } of phpNs) {
        const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
        phpChainParenOuter(`${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`, mod);
      }
    }
    // Loop 205: type-hinted DI constructor param bindings — the modern PHP
    // DI idiom where the client is injected, not constructed:
    //   public function __construct(StripeClient $sc) { $this->sc = $sc; }
    // The type hint is the proof (PHP enforces it at call time), the
    // assignment is a plain param hand-off. Single-line method
    // signatures only (multi-line signatures are not line-anchored evidence
    // -> AST track). If the param variable is written anywhere else in the
    // file (including a default value in the signature), the param is
    // dropped — never guess what the variable holds after a reassignment.
    // The proven assignment index feeds the same ambiguity guard as the
    // `new`-RHS form below.
    // Loop 207: generalized from __construct-only to any method name —
    // setter injection (`public function setClient(StripeClient $sc)
    // { $this->sc = $sc; }`) carries exactly the same type-hint proof and
    // the same pure hand-off requirement. Symfony/Laravel optional-
    // dependency setter injection is a documented first-class DI style.
    // Conflict guard: the same param name type-hinted against two
    // different providers anywhere in the file drops the param entirely
    // (file-level scope, never guess). Stricter still: the same param
    // name appearing in MORE THAN ONE single-line method signature at
    // all (typed or untyped) drops it — with setter injection the scope
    // is per-method but this pass is file-level, so a reused param name
    // (`setA(StripeClient $c)` + `setB($c)`) makes every `$this->f = $c;`
    // hand-off ambiguous. Never guess.
    {
      const phpCtorParams = new Map(); // varName -> { mod }
      const paramConflicts = new Set();
      const paramSigCount = new Map(); // varName -> #signatures mentioning it
      const provenParamRefs = [];
      for (const [cls, info] of phpClasses) provenParamRefs.push({ re: `\\??${escapeRe(cls)}`, mod: info.mod });
      for (const { mod, ns } of phpNs) {
        const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
        provenParamRefs.push({ re: `\\??${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+`, mod });
      }
      for (const sig of phpScanText.matchAll(/^[ \t]*(?:(?:public|private|protected|final|static)\s+)*function\s+[A-Za-z_]\w*\s*\(([^)\n]*)\)/gm)) {
        const seen = new Set();
        for (const pv of sig[1].matchAll(/\$(\w+)/g)) seen.add(pv[1]);
        for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
        for (const { re, mod } of provenParamRefs) {
          for (const pm of sig[1].matchAll(new RegExp(`(?:^|[(,])\\s*${re}\\s+\\$(\\w+)`, 'g'))) {
            const prev = phpCtorParams.get(pm[1]);
            if (prev && prev.mod !== mod) { paramConflicts.add(pm[1]); continue; }
            phpCtorParams.set(pm[1], { mod });
          }
        }
      }
      // Loop 222: MULTI-LINE method signatures — Prettier/PSR-12 wraps any
      // signature with several params onto one param per line, which is the
      // default Laravel/Symfony DI spelling in real codebases:
      //   public function __construct(
      //     StripeClient $sc,
      //     LoggerInterface $log,
      //   ) { $this->sc = $sc; }
      // The opener (`function name(` at statement start, optional modifier
      // prefix) is line-anchored; a balanced-paren walk collects the
      // parameter phpScanText (Loop 221's TS judgment ported to PHP). Before
      // matching, lookalike surfaces are scrubbed from the param phpScanText:
      // line comments (`//`/`#`), block comments, and string literals
      // (default values). PHP has no inline type literals, so no brace
      // scrub is needed. After the scrub, `<proven type> $param` at a
      // parameter boundary (start / `,` / newline) is grammatically a
      // type-hinted parameter and nothing else. Unbalanced parens
      // (pathological/prose input) skip the opener entirely — prefer
      // missing a binding over guessing. All downstream guards (param
      // reuse across signatures, cross-provider conflict, any other write
      // to the param) apply unchanged.
      for (const cm of phpScanText.matchAll(/^[ \t]*(?:(?:public|private|protected|final|static)\s+)*function\s+[A-Za-z_]\w*\s*\(/gm)) {
        let depth = 1;
        let i = cm.index + cm[0].length;
        while (i < phpScanText.length && depth > 0) {
          const ch = phpScanText[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        const rawParams = phpScanText.slice(cm.index + cm[0].length, i - 1);
        if (!rawParams.includes('\n')) continue; // single-line handled by the anchored matcher above
        const scrubbed = rawParams
          .replace(/\/\/[^\n]*|#[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
        const seen = new Set();
        for (const pv of scrubbed.matchAll(/\$(\w+)/g)) seen.add(pv[1]);
        for (const v of seen) paramSigCount.set(v, (paramSigCount.get(v) || 0) + 1);
        for (const { re, mod } of provenParamRefs) {
          for (const pm of scrubbed.matchAll(new RegExp(`(?:^|[(,\\n])\\s*${re}\\s+\\$(\\w+)`, 'g'))) {
            const prev = phpCtorParams.get(pm[1]);
            if (prev && prev.mod !== mod) { paramConflicts.add(pm[1]); continue; }
            phpCtorParams.set(pm[1], { mod });
          }
        }
      }
      for (const [v, n] of paramSigCount) if (n > 1) paramConflicts.add(v);
      for (const p of paramConflicts) phpCtorParams.delete(p);
      for (const [p, info] of phpCtorParams) {
        // any write to the param variable anywhere in the file drops it
        if (new RegExp(`(?<![\\w$])\\$${escapeRe(p)}(?!\\w)\\s*=(?!=)`).test(phpScanText)) continue;
        for (const m of phpScanText.matchAll(new RegExp(`\\$this\\s*->\\s*([A-Za-z_]\\w*)\\s*=\\s*\\$${escapeRe(p)}\\s*;`, 'g'))) {
          phpThisFields.set(m[1], { mod: info.mod });
          phpProvenIdx.add(m.index);
        }
      }
    }
    if (phpThisFields.size) {
      // Ambiguity guard: any other assignment to a collected field name
      // (plain `=` or `??=`, never `==` comparisons) unbinds it. Loop 306:
      // `??=` joined the binding grammar above, so a non-proven `??=` write
      // (`$this->client ??= $x`) must also unbind — same drop semantics.
      // Loop 326: bare `$this->f = null;` placeholder whitelist — the
      // standard constructor init that pairs with a guarded-if lazy-init.
      // null carries zero construction ambiguity ("not built yet", never
      // "built as something else"), so it may keep the guarded proof.
      // Strictly plain `=` only (`??=` implies an unknown prior value and
      // still drops); RHS must be a bare null literal to end of line
      // (trailing `;` allowed; comments are already blanked by phpMaskLine).
      // Conditionals (`$flag ? null : ...`) and calls never match and drop
      // as before — mirror of the Loop 324 (Python None) / 325 (JS null)
      // rulings.
      for (const m of phpScanText.matchAll(/\$this\s*->\s*([A-Za-z_]\w*)\s*(?:\?\?)?=(?!=)/g)) {
        if (!phpThisFields.has(m[1]) || phpProvenIdx.has(m.index)) continue;
        if (!m[0].includes('??')) {
          const nl = phpScanText.indexOf('\n', m.index);
          const stmt = phpScanText.slice(m.index, nl === -1 ? undefined : nl);
          if (/=\s*null\s*;?\s*$/i.test(stmt)) continue;
        }
        phpThisFields.delete(m[1]);
      }
    }
    // Loop 205: promoted constructor properties (PHP 8.0) and typed class
    // properties — the type hint itself is the binding proof (PHP enforces
    // typed properties at runtime, so whatever the field holds IS that
    // class):
    //   public function __construct(private OpenAIClient $ai) {}
    //   private StripeClient $sc;    (typed property declaration)
    // One matcher covers both spellings (visibility [readonly] [?]Type $f).
    // Exempt from the plain-assignment ambiguity guard above (the type
    // system, not the assignment, carries the proof), but conflict-guarded:
    // the same field name typed against two different providers anywhere in
    // the file drops the field entirely (file-level scope, never guess
    // which class a `$this->` chain belongs to). Known honest exposure
    // (shared with the other PHP passes): a lookalike inside a PHP string
    // literal could match — requires a proven use binding in the same file.
    {
      const conflicts = new Set();
      const collect = (re, mod) => {
        for (const m of phpScanText.matchAll(re)) {
          const prev = phpTypedFields.get(m[1]);
          if (prev && prev.mod !== mod) { conflicts.add(m[1]); continue; }
          phpTypedFields.set(m[1], { mod });
        }
      };
      for (const [cls, info] of phpClasses) {
        collect(new RegExp(`\\b(?:public|private|protected)(?:\\s+readonly)?\\s+\\??${escapeRe(cls)}\\s+\\$(\\w+)`, 'g'), info.mod);
      }
      for (const { mod, ns } of phpNs) {
        const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
        collect(new RegExp(`\\b(?:public|private|protected)(?:\\s+readonly)?\\s+\\??${lead}${escapeRe(ns)}(?:\\\\[A-Za-z_]\\w*)+\\s+\\$(\\w+)`, 'g'), mod);
      }
      for (const f of conflicts) phpTypedFields.delete(f);
    }
  }

  // Inline constructor chains: the chain root is the proven import binding
  // itself, called and dereferenced on one line — no intermediate variable:
  //   JS:      new Cloudflare({ token }).zones.get(id)
  //   Python:  OpenAI().chat.completions.create(...)   (pyClass bindings only)
  // The binding proof is the import line (exactly the same proof the variable
  // form uses); the same-line balanced-paren scan makes the read provable
  // without AST. Constructor calls whose argument list spans multiple lines
  // stay on the AST track (the closing paren is not line-anchored evidence).
  // Known limit (recorded): a string literal argument containing an unbalanced
  // paren would derail the scan for that call — worst case the chain is
  // skipped, never mis-attributed (segments must re-match the chain grammar).
  function inlineChainAfter(line, openIdx) {
    let depth = 0, i = openIdx;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) return null; // closing paren not on this line -> AST track
    const m = line.slice(i).match(/^((?:\.[A-Za-z_$][\w$]*)+)\s*\(/);
    return m ? m[1].slice(1).split('.') : null;
  }

  let rbCarry = []; // frames open at the start of the current top-level line
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Loop 273: Python prose (triple-quoted bodies, single-line string
    // content, `#` comment tails) is blanked before any matcher runs —
    // lookalikes never bind, code after a same-line closing delimiter still
    // does (offset-preserving mask). Evidence snippets keep the raw line.
    // Loop 275: JS/TS get the same treatment (`/* */` blocks incl. multi-line,
    // `//` tails, quoted string content; template `${}` slots stay code).
    // Loop 286: the pre-pass above already walked the maskers over the whole
    // file (same scanners, same cross-line state sequence) — reuse its
    // per-line output instead of walking twice. Behaviour is identical by
    // construction (single adjudicator); the Ruby path still reads raw.
    const line = maskedLines ? maskedLines[i] : rawLine;
    let rbHdBody = false; // current line is an INTERPOLATING heredoc body line
    let rbInit = []; // frames open at the start of THIS line (Loop 279)
    if (isRb) {
      if (rbHeredocQ.length) {
        if (new RegExp(`^\\s*${rbHeredocQ[0].id}\\s*$`).test(line)) { rbHeredocQ.shift(); continue; }
        // Non-interpolating body (single-quoted delimiter) is pure prose.
        // Interpolating body falls through to the chain matchers with the
        // string-frame adjudicator: only chains inside `#{ }` slots bind
        // (`log "x: #{Stripe::Charge.retrieve(id).amount}"` in a heredoc is
        // a genuine call site, Loop 270). Opener scan is skipped for body
        // lines (an opener inside an interpolation slot is an honest miss —
        // vanishingly rare, recorded).
        if (!rbHeredocQ[0].interp) continue;
        rbHdBody = true;
        // Loop 279: each interpolating heredoc carries its own frames so a
        // `#{ }` slot spanning body lines stays code position. Fresh body
        // context starts inside the string frame.
        rbInit = rbHeredocQ[0].frames || ['"'];
      } else {
        rbInit = rbCarry;
      }
      // Loop 272: block comments. Checked after the heredoc queue (a body
      // line starting with `=begin` is string content) and only at column 0
      // per Ruby grammar; trailing words after both markers are legal.
      // Loop 279: only when NO frames are open — a column-0 `=begin` inside
      // a multi-line string is string content, never a comment marker.
      if (!rbHdBody && !rbInit.length) {
        if (rbBlockComment) {
          if (/^=end\b/.test(line)) rbBlockComment = false;
          continue; // prose either way — the =end line itself carries no code
        }
        if (/^=begin\b/.test(line)) { rbBlockComment = true; continue; }
      }
      // Loop 279: cross-line frame carry — the end-of-line frame stack seeds
      // the next line of the same context (top level or this heredoc body).
      // A comment marker freezes frames at its position (comment runs to EOL).
      {
        const end = rbScan(line, line.length, rbInit);
        // Loop 286: an open regex frame does NOT carry to the next line —
        // unterminated patterns mask to end of line only (fail-safe)...
        // EXCEPT (Loop 344) frames opened right after `=`: assignment RHS
        // regexes are grammatically unambiguous and DO carry, closing the
        // multi-line /x false-positive hole (phantom bindings/chains inside
        // pattern bodies).
        const rbStripRx = (st) => st.filter((f) => !(typeof f === 'object' && f.rx && !f.carry));
        if (rbHdBody) rbHeredocQ[0].frames = rbStripRx(end.stack);
        else rbCarry = rbStripRx(end.stack);
      }
      if (!rbHdBody)
      // Opener forms: bare uppercase ID (`<<~SQL`) or a QUOTED delimiter
      // (`<<~'SQL'` / `<<-"DOC"` / `<<'EOF'`, Loop 267). Quoted delimiters
      // may be any identifier case — the quotes make the form unambiguous.
      // The quote must sit DIRECTLY after `<<[~-]?`: with whitespace in
      // between (`arr << 'ITEM'`) Ruby parses a shift/push of a string
      // literal, not a heredoc, so such lines must stay code position.
      // Bare form stays uppercase-only: `a << b` shift of a lowercase
      // identifier must never open a phantom heredoc.
      for (const hd of line.matchAll(/<<[~-]?(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Z_][A-Z0-9_]*)\b)/g)) {
        // Loop 269: opener lookalikes inside strings/comments never open a
        // heredoc — `s = "<<~SQL"` and `# use <<~SQL` are prose, and a
        // phantom queue entry would blackout the rest of the file.
        if (!rbCodeAt(line, hd.index, rbInit)) continue;
        rbHeredocQ.push({ id: hd[1] || hd[2] || hd[3], interp: !hd[1] });
      }
    }
    // skip comment lines — prose mentioning chains must not create surfaces
    // (`//`, `*`, `/*` for JS/TS; `#` for Python/Ruby/shell)
    // Heredoc body lines are exempt: a body line starting with `#` is string
    // content, not a comment (`#{...}` at line start is a real interp slot).
    // Loop 279: a Ruby line starting mid multi-line string (frames open) is
    // exempt too — a leading `#` there is string content or a slot opener.
    if (!rbHdBody && !(isRb && rbInit.length) && /^\s*(\/\/|\*|\/\*|#)/.test(line)) continue;
    // inline constructor chains (see scanner above). Only proven bindings can
    // root one; no controller-call companion is possible (there is no anchor
    // variable name for controller packs to match).
    for (const [name, b] of bindings) {
      const e = escapeRe(name);
      if (!b.pyClass && !b.pyModule && !b.goPkg) {
        // JS form requires the `new` keyword — a bare Binding(...) call in JS
        // is a plain function call whose return type is not provable here.
        for (const m of line.matchAll(new RegExp(`\\bnew\\s+${e}\\s*\\(`, 'g'))) {
          const segs = inlineChainAfter(line, m.index + m[0].length - 1);
          if (segs) calls.push({ module: b.mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      } else if (isPy && b.pyClass) {
        // Python form: the from-import proof licenses direct construction —
        // Class(...).method(...). Root must not be preceded by a word char or
        // `.` (attribute access on another object is not the proven binding).
        for (const m of line.matchAll(new RegExp(`(?<![\\w.])${e}\\s*\\(`, 'g'))) {
          const segs = inlineChainAfter(line, m.index + m[0].length - 1);
          if (segs) calls.push({ module: b.mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      }
    }
    // Ruby direct constant chains: Stripe::Charge.create(...) — the constant
    // root is proven by the require line; call parens are required so bare
    // constant mentions never produce a surface. Matches sitting inside a
    // string literal or after a trailing `#` comment marker are rejected —
    // rbCodePosition below tracks quote state character-by-character up to
    // the match (a line-anchored fact). Loop 262: `#{...}` interpolation
    // inside a double-quoted string is REAL CODE by Ruby grammar — a chain
    // sitting inside an interpolation slot is a genuine call site, so it
    // now counts as code position. Single-quoted strings never interpolate,
    // an escaped `\#{` is literal string content, and content after the
    // interpolation closes is back to prose — all three stay rejected.
    // Returns true when idx is code: top-level statement text or inside an
    // open `#{ }` interpolation frame; false inside string content or after
    // an unquoted `#` comment marker. Implemented as a frame stack so
    // nested braces (`#{h[:a] || {}.size}`) and nested string literals
    // inside the interpolation (`#{log('...')}`) resolve correctly.
    // Loop 269: implementation hoisted to the shared rbCodeAt above (the
    // heredoc opener scan needs the same adjudicator); this closure only
    // binds the current line.
    // Loop 270: on an interpolating heredoc body line the scan starts inside
    // a string frame — only `#{ }` slots are code position.
    const rbCodePosition = (idx) => rbCodeAt(line, idx, rbInit);
    for (const { mod, root } of rbConsts) {
      const er = escapeRe(root);
      for (const m of line.matchAll(new RegExp(`\\b${er}((?:::[A-Za-z_]\\w*)+)((?:\\.[a-z_]\\w*[?!]?)+)\\s*\\(`, 'g'))) {
        if (isRb && !rbCodePosition(m.index)) continue; // in-string / comment-tail lookalike
        const segs = [...m[1].slice(2).split('::'), ...m[2].slice(1).split('.')];
        // skip pure constructor lines — the instance binding pass owns those
        if (segs[segs.length - 1] === 'new') continue;
        calls.push({ module: mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
      }
      // Paren-less form: the chain is a call ONLY when the first trailing
      // token unambiguously starts an argument list — a keyword argument
      // (`customer:` — the (?!:) guard rejects `Const::Path` lookalikes), a
      // symbol (`:active`), or a string literal — OR (Loop 261) opens a
      // block: `do` is a reserved word (never an identifier/argument), and
      // in Ruby grammar a `{` directly after a paren-less chain always
      // parses as a block, never a hash argument — so `.list do |c|` and
      // `.list { |c| ... }` are grammar-guaranteed method calls even with
      // zero arguments. Prose guard: the same rbCodePosition scan (string
      // literals AND comment tails) rejects lookalikes; `\\bdo\\b` never
      // matches identifier prefixes (`dozen`). Bare-identifier args and
      // blockless zero-arg mentions never bind (prose-indistinguishable,
      // AST track).
      for (const m of line.matchAll(new RegExp(`\\b${er}((?:::[A-Za-z_]\\w*)+)((?:\\.[a-z_]\\w*[?!]?)+)[ \\t]+(?=[a-z_]\\w*:(?!:)|:[A-Za-z_]|['"]|do\\b|\\{)`, 'g'))) {
        if (!rbCodePosition(m.index)) continue; // inside a string literal / comment tail
        const segs = [...m[1].slice(2).split('::'), ...m[2].slice(1).split('.')];
        if (segs[segs.length - 1] === 'new') continue;
        calls.push({ module: mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
      }
    }
    // Ruby instance-variable chains (Loop 211): `@ivar.member.method(...)`
    // on a field proven by the constructor pass above (ambiguity-guarded,
    // file-level). Call parens required and at least two segments after the
    // field (member + method) — `@sc.pingIV(1)` is attribution too thin and
    // never binds. The same rbCodePosition prose guard applies (string
    // literals / comment tails). Paren-less ivar chains stay on the AST
    // track (no unambiguous-starter licence is defined for ivar roots yet).
    if (isRb && rbIvars.size) {
      for (const m of line.matchAll(/(?<![\w@])@([a-z_]\w*)((?:\.[a-z_]\w*[?!]?){2,})\s*\(/g)) {
        const info = rbIvars.get(m[1]);
        if (!info) continue;
        if (!rbCodePosition(m.index)) continue; // in-string / comment-tail lookalike
        const segs = m[2].slice(1).split('.');
        calls.push({ module: info.mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
      }
    }
    // PHP chains — three proven forms:
    if (phpNs.length) {
      // 1. fully-qualified static call: \Ns\A\B::method(...) — leading
      //    backslash mandatory (root proof) — plus the relative form
      //    Ns\A\B::method(...) in global-namespace files only (see the
      //    phpGlobalNs proof above). The lookbehind rejects nested vendor
      //    lookalikes (App\Stripe\...) in both forms.
      for (const { mod, ns } of phpNs) {
        const en = escapeRe(ns);
        const lead = phpGlobalNs ? `\\\\?` : `\\\\`;
        for (const m of line.matchAll(new RegExp(`(?<![\\w\\\\$])${lead}${en}((?:\\\\[A-Za-z_]\\w*)+)::([a-z_]\\w*)\\s*\\(`, 'g'))) {
          const segs = [...m[1].slice(1).split('\\'), m[2]];
          calls.push({ module: mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      }
      // 2. static call on a use-bound class: BoundClass::method(...)
      for (const [cls, info] of phpClasses) {
        for (const m of line.matchAll(new RegExp(`(?<![\\w\\\\$])${escapeRe(cls)}::([a-z_]\\w*)\\s*\\(`, 'g'))) {
          calls.push({ module: info.mod, kind: 'sdk-call', chain: `client.${[...info.segs, m[1]].join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      }
      // 3. instance chain on a proven $var: $stripe->customers->create(...)
      //    The nullsafe spelling (`?->`, PHP 8.0+) is the same member access
      //    on the same proven root — mixed chains (`->` and `?->` segments)
      //    resolve identically. Known honest limitation shared with the `->`
      //    form: a lookalike inside a PHP string literal could match —
      //    requires a proven use+new in the same file, accepted as-is.
      for (const [v, info] of phpVars) {
        for (const m of line.matchAll(new RegExp(`(?<!\\\\)\\$${escapeRe(v)}((?:\\??->[A-Za-z_]\\w*)+)\\s*\\(`, 'g'))) {
          const segs = m[1].replace(/^\?{0,1}->/, '').split(/\?->|->/);
          calls.push({ module: info.mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      }
      // 4. class-property chain: $this->stripe->charges->create(...) — the
      //    field is proven by the constructor-assignment pass above
      //    (ambiguity-guarded, file-level). Three segments minimum (field +
      //    at least one member + method) so `$this->log(...)` and
      //    `$this->stripe->ping(...)` (attribution too thin) never bind.
      //    Nullsafe segments (`?->`) resolve identically after the field.
      if (phpThisFields.size || phpTypedFields.size) {
        for (const m of line.matchAll(/(?<!\\)\$this((?:\??->[A-Za-z_]\w*)+)\s*\(/g)) {
          const segs = m[1].replace(/^\?{0,1}->/, '').split(/\?->|->/);
          if (segs.length < 3) continue;
          const tf = phpThisFields.get(segs[0]) || phpTypedFields.get(segs[0]);
          if (tf) calls.push({ module: tf.mod, kind: 'sdk-call', chain: `client.${segs.slice(1).join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
        }
      }
    }
    // Loop 234: optional-chaining and non-null-assertion chain spellings.
    // In strictNullChecks codebases the lazy-init client is dereferenced as
    // `sc?.charges.create(...)` / `sc!.refunds.create(...)` /
    // `this.f!.payouts.cancel(...)` — the exact same proven root and member
    // chain, only with `?.` (JS syntax) or a `!` assertion (TS-only syntax)
    // between segments. The markers are grammar tokens, not evidence: they
    // are stripped before dispatch so every root/field lookup below behaves
    // identically to the plain-dot form. Marker acceptance is language-gated:
    //   - `?.` in JS/TS files only (Ruby method names end in ?/!, so the
    //     marker grammar must never run there; Python/Go/PHP keep the plain
    //     regex — `?.`/`!.` are illegal syntax in all three).
    //   - `!` only in TS files (`a!.b` is a syntax error in plain JS, so a
    //     .js match could only be prose — never mint from it).
    // Ternary lookalikes never match: the marker must sit IMMEDIATELY before
    // the `.` (no whitespace slot), and JS itself lexes adjacent `?.` as the
    // optional-chain token unless followed by a digit (never an identifier).
    // `!==`/`!=` never match (the char after the marker must be `.`).
    const jsFam = !isPy && !isRb && !isGo && !isPhp;
    const chainRe = jsFam
      ? (isTs
          ? /\b([A-Za-z_$][\w$]*)((?:[?!]?\.#?[A-Za-z_$][\w$]*)+)\s*\(/g
          : /\b([A-Za-z_$][\w$]*)((?:\??\.#?[A-Za-z_$][\w$]*)+)\s*\(/g)
      : new RegExp(CHAIN_RE.source, 'g');
    for (const m of line.matchAll(chainRe)) {
      if (jsFam && /[?!]/.test(m[2])) m[2] = m[2].replace(/[?!]/g, '');
      // Loop 328: Ruby prose guard on instance-rooted chains. Ruby lines are
      // NOT pre-masked (the Ruby path reads raw and adjudicates positionally),
      // and the constant-chain / ivar-chain matchers above both carry the
      // rbCodePosition guard — but this generic root dispatch did not, so a
      // local-instance chain quoted in a string literal, a `#` comment tail,
      // or an interpolating heredoc body minted a phantom sdk-call (probe
      // loop328: dropSA1/dropSA2/dropSA3/dropSB2). Same adjudicator, same
      // wiring: prose positions never bind; `#{ }` slots still do.
      if (isRb && !rbCodePosition(m.index)) continue;
      const info = roots.get(m[1]);
      if (!info) {
        // Class-property roots: `this.<field>.<chain>(...)` dispatches the
        // FIELD segment against the this-field constructor map collected
        // above (file-level, ambiguity-guarded). Three segments minimum
        // (field + at least one member + method) so bare field calls
        // (`this.emit(...)`) and direct one-segment methods on the field
        // (`this.stripe.ping(...)` — attribution too thin) never bind.
        if (m[1] === 'this' && (thisFields.size || jsTypedFields.size || jsSetterFields.size)) {
          const segs = m[2].slice(1).split('.');
          if (segs.length >= 3) {
            const tf = thisFields.get(segs[0]) || jsTypedFields.get(segs[0]) || jsSetterFields.get(segs[0]);
            if (tf) {
              calls.push({ module: tf.mod, kind: 'sdk-call', chain: `client.${segs.slice(1).join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
              if (tf.named) {
                calls.push({ module: tf.mod, kind: 'controller-call', ctor: tf.ctor, root: `this.${segs[0]}`, chain: `this.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
              }
            }
          }
          continue;
        }
        // Loop 318: global-cache roots — `globalThis.<field>.<chain>(...)` /
        // `global.<field>.<chain>(...)` dispatch the FIELD segment against
        // the global-field constructor map collected above (file-level,
        // ambiguity-guarded across both spellings). Three segments minimum
        // (field + at least one member + method) so bare field calls
        // (a global built-in invoked directly) and one-segment methods on the field
        // (attribution too thin) never bind — mirroring the this-field rule.
        if (jsFam && (m[1] === 'globalThis' || m[1] === 'global') && jsGlobalFields.size) {
          const segs = m[2].slice(1).split('.');
          if (segs.length >= 3) {
            const gf = jsGlobalFields.get(segs[0]);
            if (gf) calls.push({ module: gf.mod, kind: 'sdk-call', chain: `client.${segs.slice(1).join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
          }
          continue;
        }
        // Loop 368: namespace-object roots — `registry.sc.<chain>(...)`
        // dispatches `root.field` against the container map collected above
        // (file-level, doubly ambiguity-guarded). Three segments minimum
        // (field + at least one member + method), mirroring the this-field
        // rule: bare field calls and one-segment methods on the field
        // (attribution too thin) never bind. Falls through on no match so
        // namespace-import roots below still get their chance.
        if (jsFam && jsNsObjFields.size) {
          const segs = m[2].slice(1).split('.');
          if (segs.length >= 3) {
            const nf = jsNsObjFields.get(`${m[1]}.${segs[0]}`);
            if (nf) {
              calls.push({ module: nf.mod, kind: 'sdk-call', chain: `client.${segs.slice(1).join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
              if (nf.named) {
                calls.push({ module: nf.mod, kind: 'controller-call', ctor: nf.ctor, root: `${m[1]}.${segs[0]}`, chain: `${m[1]}.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
              }
              continue;
            }
          }
        }
        // Python instance-attribute roots (Loop 209): `self.<field>.<chain>(...)`
        // dispatches the FIELD segment against the self-field constructor map
        // collected above (file-level, ambiguity-guarded). Three segments
        // minimum (field + at least one member + method) so bare field calls
        // (`self.log(...)`) and direct one-segment methods on the field
        // (`self.sc.ping(...)` — attribution too thin) never bind. Never
        // emits controller-call companions (Python sites must not join JS
        // `new Ctor(...)` rewrite packs).
        if (isPy && m[1] === 'self' && pySelfFields.size) {
          const segs = m[2].slice(1).split('.');
          if (segs.length >= 3) {
            const tf = pySelfFields.get(segs[0]);
            if (tf) calls.push({ module: tf.mod, kind: 'sdk-call', chain: `client.${segs.slice(1).join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
          }
          continue;
        }
        // Namespace-import roots: dispatch on the first chain segment against
        // the exporting file's proven export table. `api.default.<chain>`
        // joins the '@default' sentinel; `api.<name>.<chain>` joins the named
        // handshake. Members absent from the table never bind.
        const ns = nsRoots.find((r) => r.name === m[1]);
        if (ns) {
          let segs = m[2].slice(1).split('.');
          // `Promise.allSettled` positional bindings (Loop 253) carry the
          // namespace one level down: each settled result object exposes the
          // module namespace ONLY under `.value` (per spec, for fulfilled
          // entries). A wrap:'value' root therefore requires the first chain
          // segment to be exactly `value` and dispatches the remainder; any
          // other first segment (`.status`, direct member access on the
          // result object) is not the namespace and never binds.
          if (ns.wrap === 'value') {
            if (segs[0] !== 'value') { continue; }
            segs = segs.slice(1);
          }
          if (segs.length >= 2) {
            const key = segs[0] === 'default' ? '@default' : segs[0];
            const exp = ns.exports.find((x) => x.name === key);
            if (exp) {
              const chain = [...(exp.prefix || []), ...segs.slice(1)];
              calls.push({ module: exp.mod, kind: 'sdk-call', chain: `client.${chain.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
            } else if (ns.slots && segs.length >= 3) {
              // Two-level namespace: the first segment is a NAMESPACE SLOT on
              // the imported file (published by `export * as slot from './rel'`
              // or the CJS namespace-slot forms). The slot's value is the slot
              // target's module namespace, so the SECOND segment dispatches
              // against that target's line-proven export table ('default' maps
              // to '@default') and any remaining segments join the entry's
              // prefix. Plain table entries always win (checked above); slot
              // misses and entry misses never bind. Three segments minimum:
              // slot + entry + at least one member/method.
              const slotTable = ns.slots.get(segs[0]);
              if (slotTable) {
                const key2 = segs[1] === 'default' ? '@default' : segs[1];
                const e2 = slotTable.find((x) => x.name === key2);
                if (e2) {
                  const chain = [...(e2.prefix || []), ...segs.slice(2)];
                  calls.push({ module: e2.mod, kind: 'sdk-call', chain: `client.${chain.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
                }
              }
            }
          }
        }
        continue;
      }
      const segs = [...(info.prefix || []), ...m[2].slice(1).split('.')];
      if (!segs.length) continue;
      // Canonical, binding-agnostic surface — always emitted.
      calls.push({ module: info.mod, kind: 'sdk-call', chain: `client.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
      if (info.ctor && info.named) {
        // Companion surface for instances constructed from a *named* import
        // (e.g. `const ordersController = new OrdersController(client)`).
        // Controller-style migration packs anchor on the variable name, so
        // the real root + constructor are preserved here — matchSdkCalls
        // joins pack `controllers` metadata against this surface only when
        // ctor, anchor variable name, and leaf method all agree (mirroring
        // the fixer's own anchoring exactly; no heuristics).
        calls.push({ module: info.mod, kind: 'controller-call', ctor: info.ctor, root: m[1], chain: `${m[1]}.${segs.join('.')}`, line: i + 1, snippet: rawLine.trim().slice(0, 200) });
      }
    }
  }
  return calls;
}

export function buildInventory(repoPath) {
  const providers = Object.keys(SIGNATURES);
  const { findings, filesScanned } = scanRepo(repoPath, providers);

  // provider -> surfaceKey -> { kind, surface, sites: [] }
  const byProvider = {};
  const add = (provider, kind, surface, site) => {
    const bucket = (byProvider[provider] ||= {});
    const key = `${kind}::${surface}`;
    const entry = (bucket[key] ||= { kind, surface, sites: [] });
    if (entry.sites.length < 50) entry.sites.push(site);
  };

  for (const f of findings) {
    const site = { file: f.file, line: f.line, snippet: f.snippet };
    if (f.kind === 'import') add(f.provider, 'module', f.detail, site);
    else if (f.kind === 'env-var') add(f.provider, 'env', f.detail, site);
    else if (f.kind === 'api-host') {
      const endpoints = extractEndpoints(f.snippet, [f.detail]);
      if (endpoints.length) for (const ep of endpoints) add(f.provider, 'endpoint', ep, site);
      else add(f.provider, 'api-host', f.detail, site);
    }
  }

  // sdk-call surfaces: only files with an actual module import are re-read;
  // chains are resolved through the import binding (see extractSdkCalls) so
  // same-shaped chains on unrelated local objects are never inventoried.
  const importFiles = new Map(); // file -> Map(module -> provider)
  for (const f of findings) {
    if (f.kind !== 'import') continue;
    let mods = importFiles.get(f.file);
    if (!mods) { mods = new Map(); importFiles.set(f.file, mods); }
    mods.set(f.detail, f.provider);
  }
  for (const [file, mods] of importFiles) {
    let text;
    try { text = readFileSync(join(repoPath, file), 'utf8'); } catch { continue; }
    const isRb = file.endsWith('.rb');
    const isGo = file.endsWith('.go');
    const isPhp = file.endsWith('.php');
    // Ruby: gem -> top-level constant mapping from SIGNATURES.rbModules,
    // restricted to gems actually required in this file (mods keys).
    const rbConsts = isRb
      ? Object.values(SIGNATURES).flatMap((sig) => (sig.rbModules || []))
          .filter((rb) => mods.has(rb.gem))
          .map((rb) => ({ mod: rb.gem, root: rb.const }))
      : [];
    // Go: module path -> documented root package identifier, restricted to
    // paths actually imported in this file (mods keys).
    const goMods = isGo
      ? Object.values(SIGNATURES).flatMap((sig) => (sig.goModules || []))
          .filter((g) => mods.has(g.path))
      : [];
    // PHP: namespace root mapping from SIGNATURES.phpModules, restricted to
    // namespaces actually proven in this file (mods keys carry the ns detail).
    const phpNs = isPhp
      ? Object.values(SIGNATURES).flatMap((sig) => (sig.phpModules || []))
          .filter((p) => mods.has(p.ns))
          .map((p) => ({ mod: p.ns, ns: p.ns }))
      : [];
    for (const call of extractSdkCalls(text, [...mods.keys()], { isPy: file.endsWith('.py'), isRb, rbConsts, isGo, goMods, isPhp, phpNs, isTs: file.endsWith('.ts') || file.endsWith('.tsx') })) {
      const provider = mods.get(call.module);
      if (!provider) continue;
      const site = { file, line: call.line, snippet: call.snippet };
      if (call.kind === 'controller-call') {
        // Surface keeps the ctor so the pack join can verify the exact
        // constructor, not just the variable name.
        add(provider, 'controller-call', `${call.module} ${call.ctor} ${call.chain}`, site);
      } else {
        add(provider, 'sdk-call', `${call.module} ${call.chain}`, site);
      }
    }
  }

  // ---------- cross-module re-export join (JS module graph) ----------
  // A client proven in one file (`export const stripe = new Stripe(...)`) and
  // consumed in another (`import { stripe } from './lib/client.js'`) is two
  // line-anchored facts joined deterministically over the module graph — the
  // exported name must match the imported name and the relative specifier must
  // resolve to the exporting file. No scope tracking, no guessing: unresolved
  // specifiers (bare packages, path aliases, dynamic imports) and default
  // exports stay on the AST track.
  const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
  const exportsByFile = new Map(); // normalized repo-relative path -> [{name, mod, provider, prefix}]
  for (const [file, mods] of importFiles) {
    if (!JS_EXTS.some((e) => file.endsWith(e))) continue;
    let text;
    try { text = readFileSync(join(repoPath, file), 'utf8'); } catch { continue; }
    const exported = extractSdkCalls(text, [...mods.keys()], { collectExports: true });
    if (!exported.length) continue;
    exportsByFile.set(file.split('\\').join('/'), exported.map((r) => ({ ...r, provider: mods.get(r.mod) })));
  }
  // Re-export forwarding (barrel files): `export { a, b as c } from './rel'`
  // and `export * from './rel'` forward entries of the resolved target's
  // proven export table under this file's own path. Each forwarding statement
  // is a single line-anchored fact that creates NO local binding — the
  // forwarded members were already proven line by line in the target file, so
  // the composition stays deterministic (relative specifiers only; bare
  // packages never join). Per the ESM spec `export *` does NOT forward the
  // default export; `export { default as name }` maps '@default' -> name and
  // `export { x as default }` maps x -> '@default'. Names already present in
  // the forwarding file's own table are never overwritten (duplicate export
  // names are a syntax error in real modules — defensively skip, never
  // mis-attribute). Chains of barrels resolve via bounded fixpoint.
  if (exportsByFile.size) {
    const FWD_NAMED_RE = /^[ \t]*export\s*\{([^}]+)\}\s*from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    const FWD_STAR_RE = /^[ \t]*export\s*\*\s*from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    // ESM namespace re-export: `export * as ns from './rel'`. Per the ESM
    // spec this publishes the target's module namespace OBJECT under a named
    // slot — its members are exactly the target's line-proven export table
    // (the same insight as `import * as`, Loop 174, and the CJS
    // namespace-object-under-slot form, Loop 186). Unlike `export *`, the
    // namespace object DOES carry the target's default (as its `default`
    // member), so no @default gating applies: the slot is always published
    // as a namespace slot (kept outside the export table so no
    // head-dispatch path can ever mis-treat it as a plain entry). Consumers
    // that pick the slot by its proven name dispatch chains against the
    // target's table. Only literal relative specifiers resolve.
    const FWD_STAR_NS_RE = /^[ \t]*export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    const CJS_FWD_RE = /^[ \t]*module\.exports\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?\s*$/gm;
    // CJS property-selection barrel: `module.exports = require('./rel').name`
    // (optionally followed by further pure member segments). No value
    // semantics needed: require resolves the file (line-anchored fact) and
    // the first member is a lookup into the target's line-proven export
    // table — the same table-dispatch insight as namespace imports. Any
    // extra segments are pure member prefix accumulation (the line ends
    // right after the chain, so no call can hide in the RHS — expression
    // forms like `require('./x').y || {}` never match). The selected entry
    // is re-published as this module's '@default' (the module's export
    // value IS that member). A `.default` head maps to the '@default'
    // sentinel (ESM-interop). Members absent from the proven table never
    // forward — miss, never mis-attribute.
    const CJS_PROP_FWD_RE = /^[ \t]*module\.exports\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    // CJS named-slot property selection: `exports.pay = require('./rel').name`
    // (or `module.exports.pay = ...`). Same table-dispatch insight as the
    // whole-module property barrel above, except the selected member is
    // published as a NAMED export slot instead of '@default': the statement
    // is a single line-anchored fact naming both the public slot and the
    // selected proven member. Trailing segments are pure member prefix (the
    // line ends right after the chain — expression tails never match). An
    // `exports.default = ...` slot maps to the '@default' sentinel
    // (ESM-interop). Head misses never forward.
    const CJS_SLOT_FWD_RE = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    // CJS named-slot bare forwarding: `exports.pay = require('./rel')` (no
    // member selection). The slot's value IS the target module's whole export
    // value, so this only forwards when the target's proven table has an
    // '@default' entry (a bare `module.exports = client` / `export default
    // client` target): that entry is re-published under the named slot. A
    // target with only named exports has no single provable export value on
    // this line — nothing forwards (a namespace-object-under-slot form would
    // need one more dispatch level and stays a candidate). Line-end anchor
    // means expression tails (`require('./x') || {}`) never match; bare
    // packages never join. An `exports.default = require('./rel')` slot maps
    // to the '@default' sentinel (ESM-interop).
    const CJS_SLOT_BARE_RE = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?\s*$/gm;
    const fwdFiles = new Map(); // file -> [{kind:'named', entries:[[pub,src]], spec} | {kind:'star', spec}]
    // Namespace slots: `exports.ns = require('./namedonly')` where the target
    // has ONLY named exports. The slot's value is the target's whole exports
    // object, whose members are exactly the target's line-proven export
    // table (CJS semantics guarantee it). Consumers that pick the slot up by
    // its proven name (`const { ns } = require('./facade')`, or the ESM/
    // import spelling) get a NAMESPACE binding: chains dispatch their first
    // segment against the target's table — the same table-dispatch insight
    // as `import * as`. Kept OUTSIDE the export table so no head-dispatch
    // path can ever mis-treat these as plain entries.
    const nsSlotsByFile = new Map(); // forwarding file -> Map(slotName -> target file)
    for (const abs of walk(repoPath)) {
      const file = relative(repoPath, abs).split('\\').join('/');
      if (!JS_EXTS.some((e) => file.endsWith(e))) continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const stmts = [];
      for (const m of text.matchAll(FWD_NAMED_RE)) {
        const entries = [];
        for (const part of m[1].split(',')) {
          const toks = part.trim().split(/\s+as\s+/).map((t) => t.trim());
          const src = toks[0] || '';
          const pub = toks[1] || src;
          if (!src) continue;
          entries.push([
            pub === 'default' ? '@default' : pub,
            src === 'default' ? '@default' : src,
          ]);
        }
        if (entries.length) stmts.push({ kind: 'named', entries, spec: m[2] });
      }
      for (const m of text.matchAll(FWD_STAR_RE)) stmts.push({ kind: 'star', spec: m[1] });
      // ESM namespace re-export: publishes the target's namespace object
      // under a named slot (resolved after the fixpoint, see below).
      for (const m of text.matchAll(FWD_STAR_NS_RE)) {
        stmts.push({ kind: 'starns', spec: m[2], pub: m[1] });
      }
      // CJS barrel: `module.exports = require('./rel')` re-points this
      // module's entire exports object at the resolved target's exports.
      // A single line-anchored statement, no value semantics needed for the
      // whole-table case: every proven entry of the target — named AND the
      // '@default' sentinel — is re-published under this file's path
      // (unlike `export *`, CJS re-assignment forwards the default too,
      // because the module's export value IS the target's export value).
      // Relative specifiers only; bare packages never join.
      for (const m of text.matchAll(CJS_FWD_RE)) stmts.push({ kind: 'cjsbare', spec: m[1] });
      // CJS property-selection barrel: forwards ONE selected member of the
      // target's proven table as this module's '@default'.
      for (const m of text.matchAll(CJS_PROP_FWD_RE)) {
        const segs = m[2].slice(1).split('.');
        stmts.push({ kind: 'cjsprop', spec: m[1], segs });
      }
      // CJS named-slot property selection: publishes ONE selected member of
      // the target's proven table under the given named slot.
      for (const m of text.matchAll(CJS_SLOT_FWD_RE)) {
        const segs = m[3].slice(1).split('.');
        const pub = m[1] === 'default' ? '@default' : m[1];
        stmts.push({ kind: 'cjsslot', spec: m[2], segs, pub });
      }
      // CJS named-slot bare forwarding: publishes the target's '@default'
      // entry (its whole export value) under the given named slot.
      for (const m of text.matchAll(CJS_SLOT_BARE_RE)) {
        const pub = m[1] === 'default' ? '@default' : m[1];
        stmts.push({ kind: 'cjsslotbare', spec: m[2], pub });
      }
      if (stmts.length) fwdFiles.set(file, stmts);
    }
    const resolveSpec = (fromFile, spec) => {
      const p = posix.normalize(posix.join(posix.dirname(fromFile), spec));
      return [p, ...JS_EXTS.map((e) => p + e)].find((c) => exportsByFile.has(c)) || null;
    };
    for (let pass = 0; pass < 5 && fwdFiles.size; pass++) {
      let changed = false;
      for (const [file, stmts] of fwdFiles) {
        for (const st of stmts) {
          const target = resolveSpec(file, st.spec);
          if (!target) continue;
          const avail = exportsByFile.get(target);
          const own = exportsByFile.get(file) || [];
          const has = (n) => own.some((x) => x.name === n);
          const forward = [];
          if (st.kind === 'starns') {
            // Namespace slots are resolved after the fixpoint (the target
            // table can only grow, so the converged view is final).
            continue;
          } else if (st.kind === 'star') {
            for (const r of avail) {
              if (r.name !== '@default' && !has(r.name)) forward.push({ ...r, name: r.name });
            }
          } else if (st.kind === 'cjsbare') {
            // CJS whole-table forwarding: named entries AND '@default'.
            for (const r of avail) {
              if (!has(r.name)) forward.push({ ...r, name: r.name });
            }
          } else if (st.kind === 'cjsprop') {
            // Selected member becomes this module's whole export value:
            // dispatch the head segment against the target's proven table
            // ('default' head maps to the '@default' sentinel), accumulate
            // any remaining segments as pure member prefix, publish as
            // '@default'. Head misses never forward.
            const head = st.segs[0] === 'default' ? '@default' : st.segs[0];
            const r = avail.find((x) => x.name === head);
            if (r && !has('@default')) {
              forward.push({ ...r, name: '@default', prefix: [...(r.prefix || []), ...st.segs.slice(1)] });
            }
          } else if (st.kind === 'cjsslot') {
            // Named-slot property selection: same head dispatch + prefix
            // accumulation as cjsprop, published under the named slot.
            const head = st.segs[0] === 'default' ? '@default' : st.segs[0];
            const r = avail.find((x) => x.name === head);
            if (r && !has(st.pub)) {
              forward.push({ ...r, name: st.pub, prefix: [...(r.prefix || []), ...st.segs.slice(1)] });
            }
          } else if (st.kind === 'cjsslotbare') {
            // Bare named-slot forwarding: only the target's '@default' entry
            // (its whole export value) can be re-published under the slot —
            // named-only targets have no single provable value on this line.
            // (Named-only targets ARE handled — as namespace slots, see
            // nsSlotsByFile below — but outside the export table so no
            // head-dispatch path can ever mis-treat them as plain entries.)
            const r = avail.find((x) => x.name === '@default');
            if (r && !has(st.pub)) {
              forward.push({ ...r, name: st.pub });
            }
          } else {
            for (const [pub, src] of st.entries) {
              const r = avail.find((x) => x.name === src);
              if (r && !has(pub) && (pub === '@default' || /^[A-Za-z_$][\w$]*$/.test(pub))) {
                forward.push({ ...r, name: pub });
              }
            }
          }
          if (forward.length) {
            exportsByFile.set(file, [...own, ...forward]);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // Populate namespace slots after the fixpoint has converged (the target
    // tables can only grow during the fixpoint, so this is the final view):
    // a cjsslotbare statement whose resolved target has named entries but NO
    // '@default' publishes the slot as a namespace reference to that target.
    for (const [file, stmts] of fwdFiles) {
      for (const st of stmts) {
        if (st.kind === 'starns') {
          // `export * as ns from './rel'`: always a namespace slot — the
          // namespace object carries the target's full table (default
          // included, dispatched via the `default` member -> '@default').
          const target = resolveSpec(file, st.spec);
          if (!target) continue;
          const own = exportsByFile.get(file) || [];
          if (own.some((x) => x.name === st.pub)) continue; // never overwrite a proven name
          if (!nsSlotsByFile.has(file)) nsSlotsByFile.set(file, new Map());
          const slots = nsSlotsByFile.get(file);
          if (!slots.has(st.pub)) slots.set(st.pub, target);
          continue;
        }
        if (st.kind !== 'cjsslotbare' || st.pub === '@default') continue;
        const target = resolveSpec(file, st.spec);
        if (!target) continue;
        const avail = exportsByFile.get(target);
        if (avail.some((x) => x.name === '@default')) continue; // handled as plain entry
        const own = exportsByFile.get(file) || [];
        if (own.some((x) => x.name === st.pub)) continue; // never overwrite a proven name
        if (!nsSlotsByFile.has(file)) nsSlotsByFile.set(file, new Map());
        const slots = nsSlotsByFile.get(file);
        if (!slots.has(st.pub)) slots.set(st.pub, target);
      }
    }
    const IMPORT_RE = /^[ \t]*import\s*\{([^}]+)\}\s*from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    // CommonJS consumer form: const { stripe } = require('./lib/client')
    // (alias spelled `stripe: sc`). Same exported-name handshake, same
    // relative-specifier-only resolution. A trailing member chain after the
    // require (property selection) is handled by DESTR_PROP_REQUIRE_RE below
    // with head dispatch — the lookahead keeps this plain form from
    // mis-dispatching those keys directly against the table.
    const REQUIRE_RE = /^[ \t]*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)(?![ \t]*\.)/gm;
    // Default-import consumer forms, joined against the '@default' sentinel
    // export. The handshake is the resolved relative specifier itself: a
    // module has exactly one default export / one bare module.exports, so the
    // consumer's chosen local name needs no name match — the file resolution
    // is the proof.
    //   import billing from './lib/client.mjs'
    //   const pay = require('./lib/client')        (bare, no destructure)
    const DEFAULT_IMPORT_RE = /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    // Mixed default + named form: `import billing, { helper } from './rel'`.
    // Both segments are facts on the same anchored line — the default part
    // joins through the '@default' sentinel, the named part through the
    // exported-name handshake. No new judgement is introduced.
    const MIXED_IMPORT_RE = /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s*from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    const BARE_REQUIRE_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?\s*$/gm;
    // Consumer-side inline property selection:
    //   const pay = require('./lib/clients').stripeA;
    // Same table-dispatch insight as the cjsprop/cjsslot barrel forms — the
    // require resolves the file (line-anchored fact), the head member is a
    // lookup into the target's line-proven export table ('default' maps to
    // the '@default' sentinel, ESM-interop), and any trailing segments are
    // pure member prefix accumulation. The line ends right after the chain,
    // so expression tails (`require('./x').y || {}`) never match. The only
    // difference from the barrel forms is that the binding lives in the
    // consuming file itself instead of being re-published — which makes it
    // an externalRoot, not a forwarding entry. Head misses never bind.
    const PROP_REQUIRE_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    // Destructure of a property-selected require (consumer side):
    //   const { charges, terminal: term } = require('./lib/clients').group;
    // The head member ('group') is a lookup into the target's line-proven
    // export table ('default' maps to '@default', ESM-interop); any segments
    // between the head and the destructure trailing chain accumulate as
    // prefix; each destructured key is a pure member of the selected entry,
    // fanned out into one binding per key with that key appended to the
    // prefix. Zero calls on the line, line ends after the chain — expression
    // tails never match. Keys with defaults (`a = {}`) or rest (`...r`) are
    // not pure member picks and are skipped. Head misses never bind.
    const DESTR_PROP_REQUIRE_RE = /^[ \t]*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    // Namespace import consumer form: `import * as api from './rel'`.
    // Per the ESM spec, `api` is a const binding to the module namespace
    // object, whose members are exactly the exporting file's exports — the
    // same export table collectExports already proved line by line. So
    // `api.<exportedName>.<chain>()` composes two line-anchored facts
    // (import line resolves the file; export line proves the member) with
    // no scope tracking: `api.default.<chain>` joins the '@default'
    // sentinel, `api.<name>.<chain>` joins the named handshake. Members not
    // in the export table never bind (miss, never mis-attribute).
    const NS_IMPORT_RE = /^[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.\.?\/[^'"]+)['"]/gm;
    // Dynamic-import consumer forms. Per the ESM spec, `await import(spec)`
    // resolves to the module namespace object — whose members are exactly
    // the exporting file's line-proven export table (same insight as the
    // static `import * as` form above). The `await` unwraps the promise on
    // the same anchored line, so the lookup is table dispatch, not value
    // semantics. Promise tails (`import('./x').then(...)`) and expression
    // tails (`(await import('./x')).y || {}`) never match: the line must
    // end right after the awaited import / selection chain. Only literal
    // relative specifiers resolve (dynamic specifiers are never provable).
    //   const mod = await import('./lib/client.mjs');            (namespace binding)
    //   const pay = (await import('./lib/client.mjs')).stripeA;  (head selection)
    //   const { stripeA: sa } = await import('./lib/client.mjs'); (destructure)
    const DYN_NS_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?\s*$/gm;
    const DYN_PROP_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*await\s+import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    const DYN_DESTR_RE = /^[ \t]*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?\s*$/gm;
    //   const { charges, terminal: term } = (await import('./rel')).head.tail;
    // (destructure of a head-selected dynamic import — dynamic twin of the
    //  static DESTR_PROP_REQUIRE_RE form: head table dispatch, then per-key
    //  pure member fan-out on the selected entry's prefix.)
    const DYN_DESTR_PROP_RE = /^[ \t]*(?:const|let|var)\s*\{([^}]+)\}\s*=\s*\(\s*await\s+import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*\)((?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*$/gm;
    //   import('./rel').then(m => m.stripeA.charges.create({...}))
    // (promise-chain consumption, single-expression concise body only: the
    //  literal specifier resolves the file, the arrow param IS the module
    //  namespace object per the ESM spec — its members are exactly the
    //  target's line-proven export table — and the backreference guarantees
    //  the chain roots at that param. The param's scope is confined to the
    //  arrow, so no shadow guard is needed. Block bodies / multi-statement
    //  callbacks are real value semantics and stay on the AST track. The
    //  leading context class rejects string/template lookalikes and member
    //  calls like `foo.import(...)`.)
    const DYN_THEN_RE = /(?:^|[=(,;{]|\breturn|\bawait)\s*import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*(?:\s*\.finally\(\s*(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)\s*)*\.then\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\2((?:\.[A-Za-z_$][\w$]*)+)\s*\(/gm;
    //   import('./rel').then((m) => { await m.stripeA.charges.create({...}); ... })
    // (block-body promise-chain consumption, Loop 235: same proof as the
    //  concise form — the arrow param IS the module namespace object, so
    //  every chain rooted at the param inside the block dispatches on the
    //  target's line-proven export table. The block is collected by a
    //  balanced-brace walk (unbalanced input skips the opener — never
    //  guess); comments and string/template literals are length-preserving
    //  blanked before matching so lookalikes never bind and line numbers
    //  stay exact. The whole body is honestly dropped when the param's
    //  namespace identity can no longer be proven textually: any nested
    //  arrow or `function` (an inner param could shadow the name — spelled
    //  forms are too varied to enumerate, AST track), a redeclaration or
    //  destructuring declaration of the name, any reassignment, a `catch`
    //  binding, or a `for` head that captures it. Chains must root at the
    //  param at a non-member position (`other.m.x(...)` never matches).
    //  Loop 237: the classic function-expression callback
    //  (`.then(function (m) { ... })`, optionally async and/or named) carries
    //  the exact same proof — the single param IS the module namespace
    //  object and function expressions always have a block body, so the
    //  same brace walk + honest drops apply. A named expression's own name
    //  is a self-reference to the function (never the namespace): chains
    //  rooted at it fail the param-root anchor, and a nested `function`
    //  inside the body still drops the whole block.)
    const DYN_THEN_BLOCK_RE = /(?:^|[=(,;{]|\breturn|\bawait)\s*import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*(?:\s*\.finally\(\s*(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)\s*)*\.then\(\s*(?:async\s+)?(?:\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)\s*\))\s*\{/gm;
    for (const abs of walk(repoPath)) {
      const file = relative(repoPath, abs).split('\\').join('/');
      if (!JS_EXTS.some((e) => file.endsWith(e))) continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const externalRoots = [];
      // Namespace-slot consumers collected by the named forms below (the
      // slot name IS the handshake); merged into nsRoots further down.
      const nsExternal = [];
      const collectFrom = (re, aliasSep) => {
        for (const m of text.matchAll(re)) {
          const spec = posix.normalize(posix.join(posix.dirname(file), m[2]));
          const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
          const target = candidates.find((c) => exportsByFile.has(c) || nsSlotsByFile.has(c));
          if (!target) continue;
          const avail = exportsByFile.get(target) || [];
          const slots = nsSlotsByFile.get(target);
          for (const part of m[1].split(',')) {
            const toks = aliasSep === 'as'
              ? part.trim().split(/\s+as\s+/).map((t) => t.trim())
              : part.trim().split(':').map((t) => t.trim());
            const pub = toks[0] || '';
            const local = toks.length > 1 ? toks[1] : pub;
            const r = avail.find((x) => x.name === pub);
            const nsTarget = !r && slots ? slots.get(pub) : undefined;
            if ((r || nsTarget) && /^[A-Za-z_$][\w$]*$/.test(local)) {
              // Shadow guard: if this file declares the same identifier locally
              // (const/let/var/function/class), the import-shaped line may be
              // string/prose content or the local declaration wins — either way
              // the external proof does not hold here. Skip (never mis-attribute).
              const shadowRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b`, 'm');
              if (shadowRe.test(text)) continue;
              if (r) externalRoots.push({ name: local, mod: r.mod, prefix: r.prefix, provider: r.provider });
              else nsExternal.push({ name: local, exports: exportsByFile.get(nsTarget) });
            }
          }
        }
      };
      collectFrom(IMPORT_RE, 'as');
      collectFrom(REQUIRE_RE, ':');
      // Default-form consumers: local name is arbitrary (m[1]); the join key
      // is the '@default' sentinel in the resolved exporting file. Same
      // shadow guard as the named forms.
      const collectDefault = (re) => {
        for (const m of text.matchAll(re)) {
          const spec = posix.normalize(posix.join(posix.dirname(file), m[2]));
          const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
          const target = candidates.find((c) => exportsByFile.has(c));
          if (!target) continue;
          const r = exportsByFile.get(target).find((x) => x.name === '@default');
          if (!r) continue;
          const local = m[1];
          const shadowRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\\$/g, '\\\\$')}\\b`, 'm');
          if (re === DEFAULT_IMPORT_RE && shadowRe.test(text)) continue;
          if (re === BARE_REQUIRE_RE) {
            // The bare require line itself declares `local` — the shadow
            // guard must only reject OTHER declarations of the same name.
            const others = [...text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\\$/g, '\\\\$')}\\b.*$`, 'gm'))]
              .filter((d) => !/require\(/.test(d[0]));
            if (others.length) continue;
          }
          externalRoots.push({ name: local, mod: r.mod, prefix: r.prefix, provider: r.provider });
        }
      };
      collectDefault(DEFAULT_IMPORT_RE);
      collectDefault(BARE_REQUIRE_RE);
      // Consumer-side inline property selection:
      //   const pay = require('./lib/clients').stripeA;
      //   const q = require('./lib/clients').stripeA.terminal;   (prefix accumulation)
      // Head dispatch against the resolved file's proven export table
      // ('default' head -> '@default' sentinel); trailing segments join the
      // entry's prefix. Like the bare-require form, the statement itself is
      // the declaration of `local`, so the shadow guard only rejects OTHER
      // declarations of the same name.
      for (const m of text.matchAll(PROP_REQUIRE_RE)) {
        const spec = posix.normalize(posix.join(posix.dirname(file), m[2]));
        const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
        const target = candidates.find((c) => exportsByFile.has(c) || nsSlotsByFile.has(c));
        if (!target) continue;
        const segs = m[3].slice(1).split('.');
        const head = segs[0] === 'default' ? '@default' : segs[0];
        const avail = exportsByFile.get(target) || [];
        const r = avail.find((x) => x.name === head);
        const local = m[1];
        const others = [...text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b.*$`, 'gm'))]
          .filter((d) => !/require\(/.test(d[0]));
        if (others.length) continue;
        if (r) {
          externalRoots.push({ name: local, mod: r.mod, prefix: [...(r.prefix || []), ...segs.slice(1)], provider: r.provider });
          continue;
        }
        // Head-of-slot selection: the head member is a NAMESPACE slot on the
        // resolved file (published by cjsslotbare/starns forwarding). The
        // slot's value is the slot target's module namespace, whose members
        // are exactly that target's line-proven export table — same lookup
        // dispatch as `import * as` (never value semantics). Two shapes:
        //   const ns = require('./facade').slot;          -> namespace binding
        //   const sub = require('./facade').slot.entry.x; -> second segment
        //     dispatches against the slot target's table ('default' maps to
        //     '@default'); any remaining segments join that entry's prefix.
        // Slot names are published verbatim (never '@default'), so the raw
        // first segment is the slot key. Misses never bind.
        const slots = nsSlotsByFile.get(target);
        const slotTarget = slots ? slots.get(segs[0]) : undefined;
        if (!slotTarget) continue;
        if (segs.length === 1) {
          nsExternal.push({ name: local, exports: exportsByFile.get(slotTarget) });
        } else {
          const key2 = segs[1] === 'default' ? '@default' : segs[1];
          const e2 = exportsByFile.get(slotTarget).find((x) => x.name === key2);
          if (!e2) continue;
          externalRoots.push({ name: local, mod: e2.mod, prefix: [...(e2.prefix || []), ...segs.slice(2)], provider: e2.provider });
        }
      }
      // Destructure of a property-selected require:
      //   const { charges, terminal: term } = require('./lib/clients').group;
      // Head dispatch identical to the inline form above; each destructured
      // key then appends one more pure member segment onto the prefix and
      // creates its own binding. The statement itself declares the locals,
      // so the shadow guard only rejects OTHER declarations of the same name.
      for (const m of text.matchAll(DESTR_PROP_REQUIRE_RE)) {
        const spec = posix.normalize(posix.join(posix.dirname(file), m[2]));
        const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
        const target = candidates.find((c) => exportsByFile.has(c) || nsSlotsByFile.has(c));
        if (!target) continue;
        const segs = m[3].slice(1).split('.');
        const head = segs[0] === 'default' ? '@default' : segs[0];
        const avail = exportsByFile.get(target) || [];
        let r = avail.find((x) => x.name === head);
        // Base entry + trailing member segments the destructured keys sit on.
        // Plain-entry hit: keys append onto the entry's prefix + mid segments.
        let baseMod, basePrefix, baseProvider, slotExports = null;
        if (r) {
          baseMod = r.mod; basePrefix = [...(r.prefix || []), ...segs.slice(1)]; baseProvider = r.provider;
        } else {
          // Head-of-slot selection (same dispatch as the inline form above):
          // the head member is a NAMESPACE slot, so the destructured object
          // is the slot target's module namespace — each key is a lookup in
          // that target's line-proven export table. With a second segment
          // (`.slot.entry`) the entry is selected first ('default' maps to
          // '@default'); remaining segments and keys join its prefix.
          const slots = nsSlotsByFile.get(target);
          const slotTarget = slots ? slots.get(segs[0]) : undefined;
          if (!slotTarget) continue;
          const slotAvail = exportsByFile.get(slotTarget);
          if (segs.length === 1) {
            slotExports = slotAvail; // per-key dispatch against the table
          } else {
            const key2 = segs[1] === 'default' ? '@default' : segs[1];
            const e2 = slotAvail.find((x) => x.name === key2);
            if (!e2) continue;
            baseMod = e2.mod; basePrefix = [...(e2.prefix || []), ...segs.slice(2)]; baseProvider = e2.provider;
          }
        }
        for (const part of m[1].split(',')) {
          const raw = part.trim();
          // Defaults (`a = {}`), rest (`...r`) and nested patterns are not
          // pure member picks — skip (miss, never mis-attribute).
          if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
          const toks = raw.split(':').map((t) => t.trim());
          const key = toks[0] || '';
          const local = toks.length > 1 ? toks[1] : key;
          if (!/^[A-Za-z_$][\w$]*$/.test(key) || !/^[A-Za-z_$][\w$]*$/.test(local)) continue;
          const others = [...text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b.*$`, 'gm'))]
            .filter((d) => !/require\(/.test(d[0]));
          if (others.length) continue;
          if (slotExports) {
            // Single-segment slot head: each key dispatches the slot
            // target's table directly ('default' -> '@default' sentinel).
            const k = key === 'default' ? '@default' : key;
            const e = slotExports.find((x) => x.name === k);
            if (!e) continue; // ghost key — never bind
            externalRoots.push({ name: local, mod: e.mod, prefix: [...(e.prefix || [])], provider: e.provider });
          } else {
            externalRoots.push({ name: local, mod: baseMod, prefix: [...basePrefix, key], provider: baseProvider });
          }
        }
      }
      // Namespace-import consumers: `import * as api from './rel'`. The
      // binding carries the whole proven export table of the resolved file;
      // chain dispatch on the first segment happens in extractSdkCalls.
      // Shadow guard identical to the other forms (a local declaration of
      // the same name means the import-shaped line is not the live binding).
      const nsRoots = [...nsExternal];
      // Slot tables for two-level namespace dispatch: when the namespace-bound
      // file itself publishes namespace slots (`export * as slot from './rel'`
      // or the CJS slot forms), attach Map(slotName -> slot target's proven
      // export table) so extractSdkCalls can dispatch `api.slot.entry.<chain>`
      // (three-segment lookup — still pure table dispatch, never value
      // semantics). Files without slots attach nothing (undefined).
      const slotsTableFor = (target) => {
        const raw = nsSlotsByFile.get(target);
        if (!raw || !raw.size) return undefined;
        const out = new Map();
        for (const [slot, slotTarget] of raw) {
          const table = exportsByFile.get(slotTarget);
          if (table) out.set(slot, table);
        }
        return out.size ? out : undefined;
      };
      for (const m of text.matchAll(NS_IMPORT_RE)) {
        const spec = posix.normalize(posix.join(posix.dirname(file), m[2]));
        const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
        const target = candidates.find((c) => exportsByFile.has(c) || nsSlotsByFile.has(c));
        if (!target) continue;
        const local = m[1];
        const shadowRe = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b`, 'm');
        if (shadowRe.test(text)) continue;
        nsRoots.push({ name: local, exports: exportsByFile.get(target) || [], slots: slotsTableFor(target) });
      }
      // Dynamic-import consumers. All three statements declare their own
      // locals, so (as with the bare-require forms) the shadow guard only
      // rejects OTHER declarations of the same name.
      const othersDeclare = (local) =>
        [...text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b.*$`, 'gm'))]
          .filter((d) => !/import\(/.test(d[0])).length > 0;
      const resolveTarget = (fromSpec) => {
        const spec = posix.normalize(posix.join(posix.dirname(file), fromSpec));
        const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
        return candidates.find((c) => exportsByFile.has(c) || nsSlotsByFile.has(c));
      };
      // Unified identity guard for the nsRoots family (Loop 256). Every
      // dynamic-import namespace binding (DYN_NS/DYN_PROP/DYN_DESTR/
      // DYN_DESTR_PROP/DYN_ALL/DYN_RACE) proves what the variable holds AT
      // DECLARATION — but a later reassignment, catch binding, or for-head
      // capture destroys that identity, and binding usages after it would
      // be a false positive (the promiseVars family has carried these
      // guards since Loop 247; the nsRoots family only had othersDeclare).
      // Tests run on a prose-blanked copy with the declaration itself
      // blanked (its own `=` must not self-trip the reassignment test).
      // File-wide, not flow-sensitive: false drops are safe, false binds
      // are not.
      let dynGuardScan = null;
      let dynParamLists = null;
      const identityLost = (local, declStart, declLen) => {
        if (dynGuardScan === null) {
          dynGuardScan = text.replace(
            /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
            (s) => s.replace(/[^\n]/g, ' ')
          );
        }
        const rest = dynGuardScan.slice(0, declStart) + ' '.repeat(declLen) + dynGuardScan.slice(declStart + declLen);
        const en = local.replace(/\$/g, '\\$');
        if (new RegExp(`(?<![.\\w$])${en}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest)) return true;
        if (new RegExp(`\\bcatch\\s*\\(\\s*${en}\\b`).test(rest)) return true;
        if (new RegExp(`\\bfor\\s*\\([^)]*\\b${en}\\b`).test(rest)) return true;
        // Param-shadow (Loop 263): an inner arrow/function parameter with the
        // same name rebinds it in that scope — chains there would be false
        // positives (`items.map((m) => m.x.y())` after `const m = await
        // import(...)`). Unlike the promiseVars `[(,]…[,)]` test, these
        // forms only match REAL parameter positions, so passing the binding
        // as a plain call argument (`fn(mod)`, legal and common for
        // namespaces) never trips the guard. File-wide: false drops safe.
        //   1. bare arrow param:        m => ...
        //   2. paren list before arrow: (a, m) => ... / ({ m }) => ...
        //   3. function param list:     function f(a, m) { ... }
        // Param lists are extracted with a balanced-paren walk (Loop 264):
        // call-expression defaults put nested parens INSIDE the list, which
        // a flat `[^()]*` regex cannot cross — `(other = mk(), m) => m.x()`
        // would silently skip the guard and produce a real false bind. Only
        // the depth-0 content of the list is parameter position; anything
        // inside nested parens is an ARGUMENT to a default-value call and
        // must never trip the guard.
        if (new RegExp(`(?<![.\\w$])${en}\\s*=>`).test(rest)) return true;
        const inList = new RegExp(`(?<![\\w$])${en}(?![\\w$])`);
        if (dynParamLists === null) {
          dynParamLists = [];
          for (let i = 0; i < dynGuardScan.length; i++) {
            if (dynGuardScan[i] !== '(') continue;
            let depth = 0; let top = ''; let j = i;
            for (; j < dynGuardScan.length; j++) {
              const ch = dynGuardScan[j];
              if (ch === '(') { depth++; if (depth >= 2) top += ' '; }
              else if (ch === ')') { depth--; if (depth === 0) break; top += ' '; }
              else top += depth === 1 ? ch : ' ';
            }
            if (depth !== 0) break; // unbalanced tail: stop scanning
            const isArrow = /^\s*=>/.test(dynGuardScan.slice(j + 1));
            // Function-header lookbehind (Loop 265): grammar-shaped, not
            // line-bound — `function`, optional `*`, optional name, then
            // only whitespace up to the `(`. Formatters break long names
            // across lines (`function veryLongName\n(a, m)`); the old
            // same-line `[^()\n]*` test missed those headers, so the
            // shadow guard silently skipped the list — a real false
            // positive, not an honest miss. Nothing but the header shape
            // may sit between `function` and `(`, so unrelated parens
            // further back can never be misattributed.
            const isFn = /\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*$/.test(dynGuardScan.slice(Math.max(0, i - 200), i));
            if (isArrow || isFn) dynParamLists.push(top);
          }
        }
        for (const top of dynParamLists) {
          if (inList.test(top)) return true;
        }
        return false;
      };
      //   const [m, o] = await Promise.all([import('./a'), import('./b')]);
      // (parallel dynamic imports with positional array destructure, Loop
      //  238: Promise.all over an ARRAY LITERAL resolves positionally per
      //  spec, so the k-th pattern element IS the module namespace object of
      //  the k-th literal import specifier — pure table dispatch, identical
      //  proof to the single-import namespace form below. (Loop 253:
      //  `Promise.allSettled` shares the exact same positional alignment,
      //  but each pattern element is a settled RESULT OBJECT, not the
      //  namespace — the namespace sits one level down under `.value`. Such
      //  bindings are tagged wrap:'value' and extractSdkCalls requires the
      //  first chain segment to be exactly `value` before table dispatch;
      //  `.status` and any direct member access never bind.) Soundness of the
      //  positional split requires the whole statement to be provable at
      //  once: every array element must be a literal relative import()
      //  (any other expression may contain commas and break the alignment
      //  — the whole statement is honestly dropped), and the pattern must
      //  contain no nested patterns (same alignment risk). Per element:
      //  holes skip their position, defaults/rest are not pure namespace
      //  bindings and drop that element, and the usual other-declaration
      //  shadow guard applies. Misses never bind.)
      const DYN_ALL_RE = /^[ \t]*(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*await\s+Promise\.(all|allSettled)\(\s*\[([\s\S]*?)\]\s*\)\s*;?[ \t]*$/gm;
      // Depth-aware top-level comma split: keeps positional alignment provable
      // even when a pattern element contains braces (Loop 257 settled-value
      // pick). Commas inside {} / [] belong to the element, not the split.
      const topSplit = (s) => {
        const out = [];
        let depth = 0; let cur = '';
        for (const ch of s) {
          if (ch === '{' || ch === '[') depth++;
          else if (ch === '}' || ch === ']') depth--;
          if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
          else cur += ch;
        }
        out.push(cur);
        return out;
      };
      // Loop 257: allSettled pattern element `{ value }` / `{ value: local }`
      // destructures the settled result INLINE — the bound local IS the
      // module namespace directly (no wrap). Only the exact single-key
      // `value` pick is provable; defaults, extra keys (`status`), rest,
      // and deeper nesting are not pure namespace bindings and drop the
      // element. Plain Promise.all elements never take this form (their
      // element is the namespace itself, so `{ value: x }` would be an
      // export pick — different proof, not handled here).
      const SETTLED_PICK_RE = /^\{\s*value\s*(?::\s*([A-Za-z_$][\w$]*))?\s*\}$/;
      for (const m of text.matchAll(DYN_ALL_RE)) {
        const isSettled = m[2] === 'allSettled';
        const wrap = isSettled ? 'value' : undefined;
        const names = topSplit(m[1]).map((p) => p.trim());
        // Nested pattern elements other than the settled-value pick keep the
        // original honest drop; with the depth-aware split the alignment of
        // the REMAINING plain elements stays provable, so nesting now drops
        // per element instead of the whole statement.
        const specs = [];
        let pure = true;
        for (const part of topSplit(m[3])) {
          const raw = part.trim();
          if (!raw) { specs.push(null); continue; } // trailing comma / hole
          const im = raw.match(/^import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)$/);
          if (!im) { pure = false; break; } // non-import element: whole drop
          specs.push(im[1]);
        }
        if (!pure) continue;
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          if (!name) continue; // elision hole
          const spec = specs[i];
          if (!spec) continue;
          const target = resolveTarget(spec);
          if (!target) continue;
          if (/^[A-Za-z_$][\w$]*$/.test(name)) {
            if (othersDeclare(name)) continue;
            if (identityLost(name, m.index, m[0].length)) continue; // Loop 256
            nsRoots.push({ name, exports: exportsByFile.get(target) || [], slots: slotsTableFor(target), wrap });
            continue;
          }
          if (!isSettled) continue; // plain all: nested element is not a namespace pick
          const pick = name.match(SETTLED_PICK_RE);
          if (!pick) continue; // default/status/rest/deeper nesting: honest drop
          const local = pick[1] || 'value';
          if (othersDeclare(local)) continue;
          if (identityLost(local, m.index, m[0].length)) continue; // Loop 256
          // The pick already unwrapped `.value` — the local is the namespace.
          nsRoots.push({ name: local, exports: exportsByFile.get(target) || [], slots: slotsTableFor(target) });
        }
      }
      // const winner = await Promise.race([import('./a'), import('./a')]);
      // (Loop 254: race/any resolve to a SINGLE element value — the winner's
      //  module namespace object. Provable only when EVERY array element is
      //  a literal relative import() resolving to the SAME target file: then
      //  the value is that file's namespace regardless of which element wins,
      //  and the binding is plain table dispatch identical to DYN_NS_RE.
      //  Divergent targets, non-import elements, holes (a hole is `undefined`,
      //  which settles race immediately with a non-namespace value), and
      //  empty arrays all drop the whole statement. A rejecting race/any
      //  throws at the await — the binding line never runs, so no false
      //  positive path exists. Misses never bind.)
      const DYN_RACE_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+Promise\.(?:race|any)\(\s*\[([\s\S]*?)\]\s*\)\s*;?[ \t]*$/gm;
      for (const m of text.matchAll(DYN_RACE_RE)) {
        const parts = m[2].split(',').map((p) => p.trim());
        let target; let pure = parts.length > 0;
        for (const raw of parts) {
          if (!raw) { pure = false; break; } // hole/trailing comma: honest drop
          const im = raw.match(/^import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)$/);
          if (!im) { pure = false; break; } // non-import element: whole drop
          const t = resolveTarget(im[1]);
          if (!t) { pure = false; break; }
          if (target === undefined) target = t;
          else if (t !== target) { pure = false; break; } // divergent: winner unknown
        }
        if (!pure || !target) continue;
        if (othersDeclare(m[1])) continue;
        if (identityLost(m[1], m.index, m[0].length)) continue; // Loop 256
        nsRoots.push({ name: m[1], exports: exportsByFile.get(target) || [], slots: slotsTableFor(target) });
      }
      // const mod = await import('./rel');  -> namespace binding (full table).
      // When the resolved file itself publishes namespace slots, attach the
      // slot tables so extractSdkCalls can do the two-level dispatch
      // (`mod.slot.entry.<chain>`) — identical to the static `import * as`
      // form (Loop 191); still pure table dispatch, never value semantics.
      for (const m of text.matchAll(DYN_NS_RE)) {
        const target = resolveTarget(m[2]);
        if (!target) continue;
        if (othersDeclare(m[1])) continue;
        if (identityLost(m[1], m.index, m[0].length)) continue; // Loop 256
        nsRoots.push({ name: m[1], exports: exportsByFile.get(target) || [], slots: slotsTableFor(target) });
      }
      // const pay = (await import('./rel')).head.tail;  -> head table dispatch
      for (const m of text.matchAll(DYN_PROP_RE)) {
        const target = resolveTarget(m[2]);
        if (!target) continue;
        const segs = m[3].slice(1).split('.');
        const head = segs[0] === 'default' ? '@default' : segs[0];
        const r = (exportsByFile.get(target) || []).find((x) => x.name === head);
        if (othersDeclare(m[1])) continue;
        if (identityLost(m[1], m.index, m[0].length)) continue; // Loop 256
        if (r) {
          externalRoots.push({ name: m[1], mod: r.mod, prefix: [...(r.prefix || []), ...segs.slice(1)], provider: r.provider });
          continue;
        }
        // Head-of-slot selection (dynamic twin of the static PROP_REQUIRE
        // slot dispatch, Loop 189): the head member is a NAMESPACE slot on
        // the resolved file. Single segment binds the slot target's module
        // namespace; a second segment dispatches against that target's
        // line-proven export table ('default' -> '@default'), remaining
        // segments join the entry's prefix. Misses never bind.
        const slots = nsSlotsByFile.get(target);
        const slotTarget = slots ? slots.get(segs[0]) : undefined;
        if (!slotTarget) continue;
        if (segs.length === 1) {
          nsRoots.push({ name: m[1], exports: exportsByFile.get(slotTarget) });
        } else {
          const key2 = segs[1] === 'default' ? '@default' : segs[1];
          const e2 = exportsByFile.get(slotTarget).find((x) => x.name === key2);
          if (!e2) continue;
          externalRoots.push({ name: m[1], mod: e2.mod, prefix: [...(e2.prefix || []), ...segs.slice(2)], provider: e2.provider });
        }
      }
      // const { a, b: c } = await import('./rel');  -> per-key table dispatch
      for (const m of text.matchAll(DYN_DESTR_RE)) {
        const target = resolveTarget(m[2]);
        if (!target) continue;
        const avail = exportsByFile.get(target) || [];
        const slots = nsSlotsByFile.get(target);
        for (const part of m[1].split(',')) {
          const raw = part.trim();
          // Defaults, rest, and nested patterns are not pure member picks.
          if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
          const toks = raw.split(':').map((t) => t.trim());
          const pub = toks[0] === 'default' ? '@default' : (toks[0] || '');
          const local = toks.length > 1 ? toks[1] : toks[0];
          if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
          const r = avail.find((x) => x.name === pub);
          // Key-of-slot: a miss on the export table may still be a NAMESPACE
          // slot (published verbatim, never '@default') — the destructured
          // local then carries the slot target's proven table (same handshake
          // as the static named forms, Loop 186/188).
          const slotTarget = !r && slots ? slots.get(toks[0]) : undefined;
          if (!r && !slotTarget) continue;
          if (othersDeclare(local)) continue;
          if (identityLost(local, m.index, m[0].length)) continue; // Loop 256
          if (r) externalRoots.push({ name: local, mod: r.mod, prefix: r.prefix, provider: r.provider });
          else nsRoots.push({ name: local, exports: exportsByFile.get(slotTarget) });
        }
      }
      // const { a, b: c } = (await import('./rel')).head.tail;
      // Head dispatch on the proven export table (default head -> '@default'),
      // then per-key pure-member fan-out on the selected entry's prefix —
      // dynamic twin of the static destructure+selection form (Loop 181).
      // A head miss may still be a NAMESPACE slot (dynamic twin of the static
      // DESTR_PROP_REQUIRE slot dispatch, Loop 190): single-segment slot head
      // dispatches each key against the slot target's table; `.slot.entry`
      // selects the entry first and keys join its prefix. Misses never bind.
      for (const m of text.matchAll(DYN_DESTR_PROP_RE)) {
        const target = resolveTarget(m[2]);
        if (!target) continue;
        const segs = m[3].slice(1).split('.');
        const head = segs[0] === 'default' ? '@default' : segs[0];
        const r = (exportsByFile.get(target) || []).find((x) => x.name === head);
        let baseMod, basePrefix, baseProvider, slotExports = null;
        if (r) {
          baseMod = r.mod; basePrefix = [...(r.prefix || []), ...segs.slice(1)]; baseProvider = r.provider;
        } else {
          const slots = nsSlotsByFile.get(target);
          const slotTarget = slots ? slots.get(segs[0]) : undefined;
          if (!slotTarget) continue;
          const slotAvail = exportsByFile.get(slotTarget);
          if (segs.length === 1) {
            slotExports = slotAvail; // per-key dispatch against the slot table
          } else {
            const key2 = segs[1] === 'default' ? '@default' : segs[1];
            const e2 = slotAvail.find((x) => x.name === key2);
            if (!e2) continue;
            baseMod = e2.mod; basePrefix = [...(e2.prefix || []), ...segs.slice(2)]; baseProvider = e2.provider;
          }
        }
        for (const part of m[1].split(',')) {
          const raw = part.trim();
          // Defaults, rest, and nested patterns are not pure member picks.
          if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
          const toks = raw.split(':').map((t) => t.trim());
          const key = toks[0] || '';
          const local = toks.length > 1 ? toks[1] : key;
          if (!/^[A-Za-z_$][\w$]*$/.test(key) || !/^[A-Za-z_$][\w$]*$/.test(local)) continue;
          if (othersDeclare(local)) continue;
          if (identityLost(local, m.index, m[0].length)) continue; // Loop 256
          if (slotExports) {
            const k = key === 'default' ? '@default' : key;
            const e = slotExports.find((x) => x.name === k);
            if (!e) continue; // ghost key — never bind
            externalRoots.push({ name: local, mod: e.mod, prefix: [...(e.prefix || [])], provider: e.provider });
          } else {
            externalRoots.push({ name: local, mod: baseMod, prefix: [...basePrefix, key], provider: baseProvider });
          }
        }
      }
      // Mixed default + named consumers: `import billing, { helper } from './rel'`.
      // Same shadow guard as the pure forms, applied per segment.
      for (const m of text.matchAll(MIXED_IMPORT_RE)) {
        const spec = posix.normalize(posix.join(posix.dirname(file), m[3]));
        const candidates = [spec, ...JS_EXTS.map((e) => spec + e)];
        const target = candidates.find((c) => exportsByFile.has(c));
        if (!target) continue;
        const avail = exportsByFile.get(target);
        const shadowed = (local) =>
          new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+${local.replace(/\$/g, '\\$')}\\b`, 'm').test(text);
        // default segment -> '@default' sentinel
        const def = avail.find((x) => x.name === '@default');
        if (def && !shadowed(m[1])) {
          externalRoots.push({ name: m[1], mod: def.mod, prefix: def.prefix, provider: def.provider });
        }
        // named segment -> exported-name handshake (alias via `as`)
        for (const part of m[2].split(',')) {
          const toks = part.trim().split(/\s+as\s+/).map((t) => t.trim());
          const pub = toks[0] || '';
          const local = toks.length > 1 ? toks[1] : pub;
          const r = avail.find((x) => x.name === pub);
          if (r && /^[A-Za-z_$][\w$]*$/.test(local) && !shadowed(local)) {
            externalRoots.push({ name: local, mod: r.mod, prefix: r.prefix, provider: r.provider });
          }
        }
      }
      // import('./rel').then(m => m.head.chain(...)) — promise-chain
      // consumption (concise arrow body). The call site lives inside the
      // match itself, so the surface is emitted directly: first segment
      // after the param dispatches on the proven export table ('default'
      // -> '@default'), remaining segments extend the entry's prefix.
      const dynThenCalls = [];
      for (const m of text.matchAll(DYN_THEN_RE)) {
        const target = resolveTarget(m[1]);
        if (!target) continue;
        const segs = m[3].slice(1).split('.');
        if (segs.length < 2) continue; // need dispatch key + at least a method
        const head = segs[0] === 'default' ? '@default' : segs[0];
        let r = (exportsByFile.get(target) || []).find((x) => x.name === head);
        let rest = segs.slice(1);
        if (!r) {
          // Head-of-slot dispatch (promise-chain twin of the static/dynamic
          // slot forms, Loops 189/192): the head member is a NAMESPACE slot
          // on the resolved file — its value is the slot target's module
          // namespace, so the SECOND segment dispatches against that
          // target's line-proven export table ('default' -> '@default') and
          // the remaining segments join the entry's prefix. Needs at least
          // slot + entry + one member (segs >= 3); misses never bind.
          const slots = nsSlotsByFile.get(target);
          const slotTarget = slots ? slots.get(segs[0]) : undefined;
          if (!slotTarget || segs.length < 3) continue;
          const entry = segs[1] === 'default' ? '@default' : segs[1];
          r = (exportsByFile.get(slotTarget) || []).find((x) => x.name === entry);
          if (!r) continue;
          rest = segs.slice(2);
        }
        const line = text.slice(0, m.index).split('\n').length;
        const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
        const chain = [...(r.prefix || []), ...rest];
        dynThenCalls.push({ provider: r.provider, mod: r.mod, chain: `client.${chain.join('.')}`, line, snippet });
      }
      for (const c of dynThenCalls) {
        add(c.provider, 'sdk-call', `${c.mod} ${c.chain}`, { file, line: c.line, snippet: c.snippet });
      }
      // Block-body promise-chain consumption (Loop 235). Same table
      // dispatch as the concise form above; the body is brace-walked and
      // prose-blanked, and the whole body is dropped on any construct that
      // could break the param's namespace identity (see DYN_THEN_BLOCK_RE
      // comment). Misses never bind.
      for (const m of text.matchAll(DYN_THEN_BLOCK_RE)) {
        const target = resolveTarget(m[1]);
        if (!target) continue;
        const param = m[2] || m[3]; // arrow form vs function-expression form (Loop 237)
        // Balanced-brace walk from the `{` that ends the match. Naive about
        // braces inside strings — but the body is prose-blanked below before
        // any matching, and a premature close can only TRUNCATE the body
        // (missing calls, never minting false ones): safe direction.
        const open = m.index + m[0].length - 1;
        let depth = 1;
        let i = open + 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        const rawBody = text.slice(open + 1, i - 1);
        // Length-preserving blank of comments and string/template literals so
        // lookalikes never match and match offsets keep exact line numbers.
        const body = rawBody.replace(
          /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
          (s) => s.replace(/[^\n]/g, ' ')
        );
        const ep = param.replace(/\$/g, '\\$');
        // Honest drops: any construct that could rebind or shadow the param
        // inside the block ends the textual proof (AST track).
        if (/=>|\bfunction\b/.test(body)) continue; // nested scope: inner params may shadow
        if (new RegExp(`\\b(?:const|let|var)\\s+(?:[{\\[][^}\\]]*\\b${ep}\\b|${ep}\\b)`).test(body)) continue;
        if (new RegExp(`(?<![.\\w$])${ep}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(body)) continue;
        if (new RegExp(`\\bcatch\\s*\\(\\s*${ep}\\b`).test(body)) continue;
        if (new RegExp(`\\bfor\\s*\\([^)]*\\b(?:const|let|var)\\s+${ep}\\b`).test(body)) continue;
        for (const cm of body.matchAll(new RegExp(`(?<![\\w$.])${ep}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
          const segs = cm[1].slice(1).split('.');
          if (segs.length < 2) continue; // need dispatch key + at least a method
          const head = segs[0] === 'default' ? '@default' : segs[0];
          let r = (exportsByFile.get(target) || []).find((x) => x.name === head);
          let rest = segs.slice(1);
          if (!r) {
            const slots = nsSlotsByFile.get(target);
            const slotTarget = slots ? slots.get(segs[0]) : undefined;
            if (!slotTarget || segs.length < 3) continue;
            const entry = segs[1] === 'default' ? '@default' : segs[1];
            r = (exportsByFile.get(slotTarget) || []).find((x) => x.name === entry);
            if (!r) continue;
            rest = segs.slice(2);
          }
          const line = text.slice(0, open + 1 + cm.index).split('\n').length;
          const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
          const chain = [...(r.prefix || []), ...rest];
          add(r.provider, 'sdk-call', `${r.mod} client.${chain.join('.')}`, { file, line, snippet });
        }
      }
      // Destructured `.then` callback param (Loop 249):
      //   import('./rel').then(({ stripeClient: sc }) => sc.charges.create({...}))
      //   import('./rel').then(({ default: d }) => { d.payouts.list(); })
      // The callback param destructures the module namespace object, so each
      // key is a pure member pick against the target's line-proven export
      // table ('default' -> '@default') — the exact same per-key judgement as
      // the awaited destructure form (DYN_DESTR_RE), carried into the promise
      // callback. A key miss may still be a NAMESPACE slot: the local then
      // carries the slot target's table and its first usage segment
      // dispatches there (two-level, same as the plain-param forms).
      // Defaults, rest, and nested patterns are never pure picks (per-key
      // drop). Concise bodies are self-contained (the root must be one of
      // the pattern's locals at non-member position); block bodies reuse the
      // DYN_THEN_BLOCK brace walk + prose blank, drop the whole body on any
      // nested arrow/function, and drop a single local on redeclaration,
      // reassignment, catch binding, or for-head capture. Final chains must
      // keep at least resource + method after prefix join; misses never bind.
      const DYN_THEN_DESTR_RE = /(?:^|[=(,;{]|\breturn|\bawait)\s*import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*(?:\s*\.finally\(\s*(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)\s*)*\.then\(\s*(?:async\s+)?\(\s*\{([^}]+)\}\s*\)\s*=>\s*([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+)\s*\(/gm;
      // Block bodies come in two callback shapes carrying the same proof:
      // arrow (`({x}) => {`) and function expression (`function ({x}) {`) —
      // function expressions have no concise form, so only the block regex
      // grows the alternative (Loop 251). Pattern lands in group 2 or 3.
      const DYN_THEN_DESTR_BLOCK_RE = /(?:^|[=(,;{]|\breturn|\bawait)\s*import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*(?:\s*\.finally\(\s*(?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)\s*)*\.then\(\s*(?:async\s+)?(?:\(\s*\{([^}]+)\}\s*\)\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*\{([^}]+)\}\s*\))\s*\{/gm;
      // Parse the pattern into provable roots: local -> export entry (r) or
      // slot table (slotExports). Impure picks and ghost keys are skipped.
      const destrThenRoots = (patternStr, target) => {
        const avail = exportsByFile.get(target) || [];
        const slots = nsSlotsByFile.get(target);
        const roots = new Map();
        for (const part of patternStr.split(',')) {
          const raw = part.trim();
          if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
          const toks = raw.split(':').map((t) => t.trim());
          const pub = toks[0] === 'default' ? '@default' : (toks[0] || '');
          const local = toks.length > 1 ? toks[1] : toks[0];
          if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
          const r = avail.find((x) => x.name === pub);
          const slotTarget = !r && slots ? slots.get(toks[0]) : undefined;
          if (!r && !slotTarget) continue;
          roots.set(local, r ? { r } : { slotExports: exportsByFile.get(slotTarget) || [] });
        }
        return roots;
      };
      // Resolve a usage chain rooted at a destructured local into a surface;
      // returns null on any miss (never bind). Requires resource + method
      // after prefix join (single bare member calls stay silent).
      const destrThenChain = (entry, segsStr) => {
        const segs = segsStr.slice(1).split('.');
        let r, tail;
        if (entry.r) {
          r = entry.r;
          tail = segs;
        } else {
          if (segs.length < 2) return null;
          const head = segs[0] === 'default' ? '@default' : segs[0];
          r = entry.slotExports.find((x) => x.name === head);
          if (!r) return null;
          tail = segs.slice(1);
        }
        const chain = [...(r.prefix || []), ...tail];
        if (chain.length < 2) return null;
        return { provider: r.provider, mod: r.mod, chain: `client.${chain.join('.')}` };
      };
      for (const m of text.matchAll(DYN_THEN_DESTR_RE)) {
        const target = resolveTarget(m[1]);
        if (!target) continue;
        const entry = destrThenRoots(m[2], target).get(m[3]);
        if (!entry) continue;
        const c = destrThenChain(entry, m[4]);
        if (!c) continue;
        const line = text.slice(0, m.index).split('\n').length;
        const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
        add(c.provider, 'sdk-call', `${c.mod} ${c.chain}`, { file, line, snippet });
      }
      for (const m of text.matchAll(DYN_THEN_DESTR_BLOCK_RE)) {
        const target = resolveTarget(m[1]);
        if (!target) continue;
        const roots = destrThenRoots(m[2] || m[3], target);
        if (!roots.size) continue;
        const open = m.index + m[0].length - 1;
        let depth = 1;
        let i = open + 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        if (depth !== 0) continue; // unbalanced: never guess
        const rawBody = text.slice(open + 1, i - 1);
        const body = rawBody.replace(
          /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
          (s) => s.replace(/[^\n]/g, ' ')
        );
        if (/=>|\bfunction\b/.test(body)) continue; // nested scope: inner params may shadow
        for (const [local, entry] of roots) {
          const ep = local.replace(/\$/g, '\\$');
          if (new RegExp(`\\b(?:const|let|var)\\s+(?:[{\\[][^}\\]]*\\b${ep}\\b|${ep}\\b)`).test(body)) continue;
          if (new RegExp(`(?<![.\\w$])${ep}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(body)) continue;
          if (new RegExp(`\\bcatch\\s*\\(\\s*${ep}\\b`).test(body)) continue;
          if (new RegExp(`\\bfor\\s*\\([^)]*\\b(?:const|let|var)\\s+${ep}\\b`).test(body)) continue;
          for (const cm of body.matchAll(new RegExp(`(?<![\\w$.])${ep}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
            const c = destrThenChain(entry, cm[1]);
            if (!c) continue;
            const line = text.slice(0, open + 1 + cm.index).split('\n').length;
            const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
            add(c.provider, 'sdk-call', `${c.mod} ${c.chain}`, { file, line, snippet });
          }
        }
      }
      // Promise-stored dynamic import consumption (Loop 242):
      //   const clientsP = import('./rel');
      //   clientsP.then((m) => m.stripeA.charges.create({...}));
      // The declaration binds a PROMISE of the module namespace — the
      // variable itself is never a namespace root (the promise-tail
      // negatives above stay silent) — but every `.then` callback param
      // on that variable IS the namespace object, the exact same proof
      // as the inline `import('./rel').then(...)` forms. Soundness needs
      // the variable's promise identity to hold file-wide: the
      // declaration must be line-anchored with a literal relative
      // specifier and end at the import call (no tails), and the name
      // must never be redeclared (any scope), reassigned, caught, or
      // captured by a for head anywhere else in the file — conservative
      // whole-file drop, misses never bind. Usages are matched against a
      // length-preserving prose-blanked copy of the file so comment and
      // string lookalikes never bind (the inline forms get this for free
      // from their leading-context class; a bare identifier does not).
      // Chained tails (`p.then(...).then(cb)`) never match: the second
      // `.then` is member position on the call result, not the variable.
      const PROMISE_VAR_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)\s*;?[ \t]*$/gm;
      const promiseVars = [];
      for (const m of text.matchAll(PROMISE_VAR_RE)) {
        const target = resolveTarget(m[2]);
        if (!target) continue;
        if (othersDeclare(m[1])) continue;
        promiseVars.push({ name: m[1], target, declStart: m.index, declLen: m[0].length });
      }
      if (promiseVars.length) {
        const scan = text.replace(
          /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
          (s) => s.replace(/[^\n]/g, ' ')
        );
        const provenPv = new Map(); // guard-surviving promise vars (Loop 247)
        for (const pv of promiseVars) {
          const en = pv.name.replace(/\$/g, '\\$');
          // Identity guards run on the blanked text with the declaration
          // itself blanked too (its own `=` must not self-trip the
          // reassignment test). False drops are safe; false binds are not.
          const rest = scan.slice(0, pv.declStart) + ' '.repeat(pv.declLen) + scan.slice(pv.declStart + pv.declLen);
          if (new RegExp(`(?<![.\\w$])${en}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest)) continue;
          if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${en}\\b`).test(rest)) continue;
          if (new RegExp(`\\bcatch\\s*\\(\\s*${en}\\b`).test(rest)) continue;
          if (new RegExp(`\\bfor\\s*\\([^)]*\\b${en}\\b`).test(rest)) continue;
          provenPv.set(pv.name, pv); // survived all identity guards (Loop 247)
          // Same table dispatch as the inline `.then` forms (head on the
          // proven export table, 'default' -> '@default', head-of-slot
          // two-level fallback); misses never bind.
          const emitChain = (segsStr, absOffset) => {
            const segs = segsStr.slice(1).split('.');
            if (segs.length < 2) return;
            const head = segs[0] === 'default' ? '@default' : segs[0];
            let r = (exportsByFile.get(pv.target) || []).find((x) => x.name === head);
            let restSegs = segs.slice(1);
            if (!r) {
              const slots = nsSlotsByFile.get(pv.target);
              const slotTarget = slots ? slots.get(segs[0]) : undefined;
              if (!slotTarget || segs.length < 3) return;
              const entry = segs[1] === 'default' ? '@default' : segs[1];
              r = (exportsByFile.get(slotTarget) || []).find((x) => x.name === entry);
              if (!r) return;
              restSegs = segs.slice(2);
            }
            const line = text.slice(0, absOffset).split('\n').length;
            const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
            const chain = [...(r.prefix || []), ...restSegs];
            add(r.provider, 'sdk-call', `${r.mod} client.${chain.join('.')}`, { file, line, snippet });
          };
          // Concise arrow body: pv.then(m => m.head.chain(...))
          const conciseRe = new RegExp(`(?<![\\w$.])${en}(?:\\s*\\.finally\\(\\s*(?:[^()]|\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))*\\)\\s*)*\\.then\\(\\s*(?:async\\s+)?\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g');
          for (const um of scan.matchAll(conciseRe)) emitChain(um[2], um.index);
          // Block-body arrow / function-expression callbacks: same brace
          // walk and honest-drop rules as DYN_THEN_BLOCK_RE (body is
          // already prose-blanked as part of `scan`).
          const blockRe = new RegExp(`(?<![\\w$.])${en}(?:\\s*\\.finally\\(\\s*(?:[^()]|\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))*\\)\\s*)*\\.then\\(\\s*(?:async\\s+)?(?:\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\))\\s*\\{`, 'g');
          for (const um of scan.matchAll(blockRe)) {
            const param = um[1] || um[2];
            const open = um.index + um[0].length - 1;
            let depth = 1;
            let j = open + 1;
            while (j < scan.length && depth > 0) {
              const ch = scan[j];
              if (ch === '{') depth++;
              else if (ch === '}') depth--;
              j++;
            }
            if (depth !== 0) continue; // unbalanced: never guess
            const body = scan.slice(open + 1, j - 1);
            const ep = param.replace(/\$/g, '\\$');
            if (/=>|\bfunction\b/.test(body)) continue; // nested scope: inner params may shadow
            if (new RegExp(`\\b(?:const|let|var)\\s+(?:[{\\[][^}\\]]*\\b${ep}\\b|${ep}\\b)`).test(body)) continue;
            if (new RegExp(`(?<![.\\w$])${ep}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(body)) continue;
            if (new RegExp(`\\bcatch\\s*\\(\\s*${ep}\\b`).test(body)) continue;
            if (new RegExp(`\\bfor\\s*\\([^)]*\\b(?:const|let|var)\\s+${ep}\\b`).test(body)) continue;
            for (const cm of body.matchAll(new RegExp(`(?<![\\w$.])${ep}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
              emitChain(cm[1], open + 1 + cm.index);
            }
          }
          // Destructured `.then` callback param on a stored promise (Loop 250):
          //   pv.then(({ key: local }) => local.chain(...))
          //   pv.then(({ key }) => { key.chain(...); ... })
          // Same proof as the inline `import('./rel').then(({...}) => ...)`
          // forms (Loop 249): the callback param destructures the module
          // namespace object, so each pure member pick dispatches on the
          // proven export table / NAMESPACE slot table via destrThenRoots.
          // Usages match on the prose-blanked scan; the concise form
          // requires the chain root to be a pattern local in non-member
          // position, and the block form inherits the full honest-drop set
          // (nested scope, redeclaration, reassignment, catch, for head).
          const destrConciseRe = new RegExp(`(?<![\\w$.])${en}(?:\\s*\\.finally\\(\\s*(?:[^()]|\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))*\\)\\s*)*\\.then\\(\\s*(?:async\\s+)?\\(\\s*\\{([^}]+)\\}\\s*\\)\\s*=>\\s*([A-Za-z_$][\\w$]*)((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g');
          for (const um of scan.matchAll(destrConciseRe)) {
            const entry = destrThenRoots(um[1], pv.target).get(um[2]);
            if (!entry) continue;
            const c = destrThenChain(entry, um[3]);
            if (!c) continue;
            const line = text.slice(0, um.index).split('\n').length;
            const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
            add(c.provider, 'sdk-call', `${c.mod} ${c.chain}`, { file, line, snippet });
          }
          const destrBlockRe = new RegExp(`(?<![\\w$.])${en}(?:\\s*\\.finally\\(\\s*(?:[^()]|\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))*\\)\\s*)*\\.then\\(\\s*(?:async\\s+)?(?:\\(\\s*\\{([^}]+)\\}\\s*\\)\\s*=>|function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(\\s*\\{([^}]+)\\}\\s*\\))\\s*\\{`, 'g');
          for (const um of scan.matchAll(destrBlockRe)) {
            const roots = destrThenRoots(um[1] || um[2], pv.target);
            if (!roots.size) continue;
            const open = um.index + um[0].length - 1;
            let depth = 1;
            let j = open + 1;
            while (j < scan.length && depth > 0) {
              const ch = scan[j];
              if (ch === '{') depth++;
              else if (ch === '}') depth--;
              j++;
            }
            if (depth !== 0) continue; // unbalanced: never guess
            const body = scan.slice(open + 1, j - 1);
            if (/=>|\bfunction\b/.test(body)) continue; // nested scope: inner params may shadow
            for (const [local, entry] of roots) {
              const ep = local.replace(/\$/g, '\\$');
              if (new RegExp(`\\b(?:const|let|var)\\s+(?:[{\\[][^}\\]]*\\b${ep}\\b|${ep}\\b)`).test(body)) continue;
              if (new RegExp(`(?<![.\\w$])${ep}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(body)) continue;
              if (new RegExp(`\\bcatch\\s*\\(\\s*${ep}\\b`).test(body)) continue;
              if (new RegExp(`\\bfor\\s*\\([^)]*\\b(?:const|let|var)\\s+${ep}\\b`).test(body)) continue;
              for (const cm of body.matchAll(new RegExp(`(?<![\\w$.])${ep}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
                const c = destrThenChain(entry, cm[1]);
                if (!c) continue;
                const line = text.slice(0, open + 1 + cm.index).split('\n').length;
                const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
                add(c.provider, 'sdk-call', `${c.mod} ${c.chain}`, { file, line, snippet });
              }
            }
          }
          // Awaited-namespace variable: `const m = await pv;` transfers the
          // promise's namespace identity into a plain variable (Loop 243).
          // `await <promise-of-namespace>` IS the module namespace object —
          // the same proof as the `.then` param, carried through a variable
          // instead of a callback. Soundness mirrors the promise variable's
          // own rules: declaration must be line-anchored with no tails, and
          // the awaited name must hold its identity file-wide — any other
          // declaration (even another `= await pv` of the same name — two
          // scopes could interleave and we refuse to reason about scopes),
          // reassignment, catch binding, or for-head capture drops the name
          // entirely. Destructured heads (`const { x } = await pv`) and
          // parenthesized inline forms (`(await pv).x`) are different cells;
          // both stay honest misses here. Chains are matched on the
          // prose-blanked scan, so comment/string lookalikes never bind.
          const AWAIT_VAR_RE = new RegExp(`^[ \\t]*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${en}\\s*;?[ \\t]*$`, 'gm');
          for (const am of scan.matchAll(AWAIT_VAR_RE)) {
            const aname = am[1];
            if (aname === pv.name) continue; // self-shadow: never reason about it
            const ea = aname.replace(/\$/g, '\\$');
            // Blank this declaration too before identity tests (its own
            // `const`/`=` must not self-trip the guards below).
            const rest2 = rest.slice(0, am.index) + ' '.repeat(am[0].length) + rest.slice(am.index + am[0].length);
            if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${ea}\\b`).test(rest2)) continue;
            if (new RegExp(`(?<![.\\w$])${ea}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest2)) continue;
            if (new RegExp(`\\bcatch\\s*\\(\\s*${ea}\\b`).test(rest2)) continue;
            if (new RegExp(`\\bfor\\s*\\([^)]*\\b${ea}\\b`).test(rest2)) continue;
            // Param-shadow guard: if the name ever appears in arrow/function
            // parameter position (or as any parenthesized/comma-adjacent
            // binding candidate), an inner scope could rebind it — drop the
            // name file-wide. Passing it as a plain call argument also
            // matches this pattern; that is a false drop, which is safe.
            if (new RegExp(`${ea}\\s*=>`).test(rest2)) continue;
            if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${ea}\\s*[,)]`).test(rest2)) continue;
            for (const cm of rest2.matchAll(new RegExp(`(?<![\\w$.])${ea}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
              emitChain(cm[1], cm.index);
            }
          }
          // Destructured head from a stored promise: `const { a, b: c } = await pv;`
          // (Loop 244). Each pure member pick is the same per-key table
          // dispatch as the inline `const {...} = await import('./rel')`
          // form (DYN_DESTR_RE) — the awaited value IS the module namespace
          // object, so a key either names a proven export (the local then
          // carries that entry's prefix) or a NAMESPACE slot (the local then
          // carries the slot target's proven table). Defaults, rest, and
          // nested patterns are not pure member picks — dropped per key.
          // Because these locals are bare file-level identifiers (no body
          // isolation), each local inherits the full second-order identity
          // guard set from the awaited-variable form above: redeclaration,
          // reassignment, catch binding, for-head capture, and param-shadow
          // anywhere in the file drop the local entirely. False drops are
          // safe; false binds are not. Chains match on the prose-blanked
          // scan, so comment/string lookalikes never bind.
          const AWAIT_DESTR_RE = new RegExp(`^[ \\t]*(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*await\\s+${en}\\s*;?[ \\t]*$`, 'gm');
          for (const dm of scan.matchAll(AWAIT_DESTR_RE)) {
            const rest3 = rest.slice(0, dm.index) + ' '.repeat(dm[0].length) + rest.slice(dm.index + dm[0].length);
            for (const part of dm[1].split(',')) {
              const raw = part.trim();
              // Defaults, rest, and nested patterns are not pure member picks.
              if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
              const toks = raw.split(':').map((t) => t.trim());
              const pub = toks[0] === 'default' ? '@default' : (toks[0] || '');
              const local = toks.length > 1 ? toks[1] : toks[0];
              if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
              if (local === pv.name) continue; // self-shadow: never reason about it
              const avail = exportsByFile.get(pv.target) || [];
              const r = avail.find((x) => x.name === pub);
              const slots = nsSlotsByFile.get(pv.target);
              const slotTarget = !r && slots ? slots.get(toks[0]) : undefined;
              if (!r && !slotTarget) continue;
              const el = local.replace(/\$/g, '\\$');
              if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${el}\\b`).test(rest3)) continue;
              if (new RegExp(`(?<![.\\w$])${el}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest3)) continue;
              if (new RegExp(`\\bcatch\\s*\\(\\s*${el}\\b`).test(rest3)) continue;
              if (new RegExp(`\\bfor\\s*\\([^)]*\\b${el}\\b`).test(rest3)) continue;
              if (new RegExp(`${el}\\s*=>`).test(rest3)) continue;
              if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${el}\\s*[,)]`).test(rest3)) continue;
              for (const cm of rest3.matchAll(new RegExp(`(?<![\\w$.])${el}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
                const segs = cm[1].slice(1).split('.');
                if (!segs.length) continue;
                let entry = r;
                let restSegs = segs;
                if (!entry) {
                  // Slot pick: the local is the slot target's namespace —
                  // first chain segment dispatches that target's proven
                  // export table ('default' -> '@default'), remaining
                  // segments join the entry's prefix. Misses never bind.
                  if (segs.length < 2) continue;
                  const head2 = segs[0] === 'default' ? '@default' : segs[0];
                  entry = (exportsByFile.get(slotTarget) || []).find((x) => x.name === head2);
                  if (!entry) continue;
                  restSegs = segs.slice(1);
                }
                const line = text.slice(0, cm.index).split('\n').length;
                const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
                const chain = [...(entry.prefix || []), ...restSegs];
                add(entry.provider, 'sdk-call', `${entry.mod} client.${chain.join('.')}`, { file, line, snippet });
              }
            }
          }
          // Destructured pick off a trailing selection on the awaited stored
          // promise: `const { a, b: c } = (await pv).head.tail;` (Loop 245).
          // Statement head dispatch mirrors the inline
          // `(await import('./rel')).head.tail` form (DYN_DESTR_PROP_RE):
          // the head segment resolves against the proven export table
          // ('default' -> '@default'); a head miss may still be a NAMESPACE
          // slot — a single-segment slot head dispatches each key against the
          // slot target's table, `.slot.entry` selects the entry first and
          // keys join its prefix. Defaults, rest, and nested patterns are not
          // pure member picks — dropped per key. Each local is a bare
          // file-level identifier, so it inherits the full second-order
          // identity guard set (redeclaration, reassignment, catch binding,
          // for-head capture, param-shadow — any hit drops the local
          // file-wide). Misses never bind; false drops are safe.
          const AWAIT_DESTR_PROP_RE = new RegExp(`^[ \\t]*(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*\\(\\s*await\\s+${en}\\s*\\)((?:\\.[A-Za-z_$][\\w$]*)+)\\s*;?[ \\t]*$`, 'gm');
          for (const dm of scan.matchAll(AWAIT_DESTR_PROP_RE)) {
            const segs = dm[2].slice(1).split('.');
            const head = segs[0] === 'default' ? '@default' : segs[0];
            const r0 = (exportsByFile.get(pv.target) || []).find((x) => x.name === head);
            let baseMod, basePrefix, baseProvider, slotExports = null;
            if (r0) {
              baseMod = r0.mod; basePrefix = [...(r0.prefix || []), ...segs.slice(1)]; baseProvider = r0.provider;
            } else {
              const slots = nsSlotsByFile.get(pv.target);
              const slotTarget = slots ? slots.get(segs[0]) : undefined;
              if (!slotTarget) continue;
              const slotAvail = exportsByFile.get(slotTarget) || [];
              if (segs.length === 1) {
                slotExports = slotAvail; // per-key dispatch against the slot table
              } else {
                const key2 = segs[1] === 'default' ? '@default' : segs[1];
                const e2 = slotAvail.find((x) => x.name === key2);
                if (!e2) continue;
                baseMod = e2.mod; basePrefix = [...(e2.prefix || []), ...segs.slice(2)]; baseProvider = e2.provider;
              }
            }
            const rest3 = rest.slice(0, dm.index) + ' '.repeat(dm[0].length) + rest.slice(dm.index + dm[0].length);
            for (const part of dm[1].split(',')) {
              const raw = part.trim();
              // Defaults, rest, and nested patterns are not pure member picks.
              if (!raw || raw.includes('=') || raw.includes('...') || raw.includes('{') || raw.includes('[')) continue;
              const toks = raw.split(':').map((t) => t.trim());
              const key = toks[0] || '';
              const local = toks.length > 1 ? toks[1] : key;
              if (!/^[A-Za-z_$][\w$]*$/.test(key) || !/^[A-Za-z_$][\w$]*$/.test(local)) continue;
              if (local === pv.name) continue; // self-shadow: never reason about it
              let entryMod, entryPrefix, entryProvider;
              if (slotExports) {
                const k = key === 'default' ? '@default' : key;
                const e = slotExports.find((x) => x.name === k);
                if (!e) continue; // ghost key — never bind
                entryMod = e.mod; entryPrefix = [...(e.prefix || [])]; entryProvider = e.provider;
              } else {
                entryMod = baseMod; entryPrefix = [...basePrefix, key]; entryProvider = baseProvider;
              }
              const el = local.replace(/\$/g, '\\$');
              if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${el}\\b`).test(rest3)) continue;
              if (new RegExp(`(?<![.\\w$])${el}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest3)) continue;
              if (new RegExp(`\\bcatch\\s*\\(\\s*${el}\\b`).test(rest3)) continue;
              if (new RegExp(`\\bfor\\s*\\([^)]*\\b${el}\\b`).test(rest3)) continue;
              if (new RegExp(`${el}\\s*=>`).test(rest3)) continue;
              if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${el}\\s*[,)]`).test(rest3)) continue;
              for (const cm of rest3.matchAll(new RegExp(`(?<![\\w$.])${el}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
                const chainSegs = cm[1].slice(1).split('.');
                if (!chainSegs.length) continue;
                const line = text.slice(0, cm.index).split('\n').length;
                const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
                const chain = [...entryPrefix, ...chainSegs];
                add(entryProvider, 'sdk-call', `${entryMod} client.${chain.join('.')}`, { file, line, snippet });
              }
            }
          }
          // Plain variable bound to a trailing selection on the awaited
          // stored promise: `const x = (await pv).head.tail;` (Loop 246) —
          // the variable-ized twin of the inline paren form and the
          // non-destructure sibling of AWAIT_DESTR_PROP_RE above. The
          // statement head dispatches the proven export table
          // ('default' -> '@default'); a head miss may still be a NAMESPACE
          // slot: a single-segment slot head makes the local the slot
          // target's namespace (usage chains dispatch that table per first
          // segment), while `.slot.entry[.more]` resolves the entry first
          // and the local carries entry prefix + remaining segments. The
          // local is a bare file-level identifier, so it inherits the full
          // second-order identity guard set (redeclaration, reassignment,
          // catch binding, for-head capture, param-shadow — any hit drops
          // the local file-wide). Misses never bind; false drops are safe.
          const AWAIT_PROP_VAR_RE = new RegExp(`^[ \\t]*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(\\s*await\\s+${en}\\s*\\)((?:\\.[A-Za-z_$][\\w$]*)+)\\s*;?[ \\t]*$`, 'gm');
          for (const vm of scan.matchAll(AWAIT_PROP_VAR_RE)) {
            const local = vm[1];
            if (local === pv.name) continue; // self-shadow: never reason about it
            const segs = vm[2].slice(1).split('.');
            const head = segs[0] === 'default' ? '@default' : segs[0];
            const r0 = (exportsByFile.get(pv.target) || []).find((x) => x.name === head);
            let entryMod, entryPrefix, entryProvider, slotExports = null;
            if (r0) {
              entryMod = r0.mod; entryPrefix = [...(r0.prefix || []), ...segs.slice(1)]; entryProvider = r0.provider;
            } else {
              const slots = nsSlotsByFile.get(pv.target);
              const slotTarget = slots ? slots.get(segs[0]) : undefined;
              if (!slotTarget) continue; // ghost head — never bind
              const slotAvail = exportsByFile.get(slotTarget) || [];
              if (segs.length === 1) {
                slotExports = slotAvail; // local IS the slot namespace — per-usage dispatch
              } else {
                const key2 = segs[1] === 'default' ? '@default' : segs[1];
                const e2 = slotAvail.find((x) => x.name === key2);
                if (!e2) continue;
                entryMod = e2.mod; entryPrefix = [...(e2.prefix || []), ...segs.slice(2)]; entryProvider = e2.provider;
              }
            }
            const el = local.replace(/\$/g, '\\$');
            const rest4 = rest.slice(0, vm.index) + ' '.repeat(vm[0].length) + rest.slice(vm.index + vm[0].length);
            if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${el}\\b`).test(rest4)) continue;
            if (new RegExp(`(?<![.\\w$])${el}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(rest4)) continue;
            if (new RegExp(`\\bcatch\\s*\\(\\s*${el}\\b`).test(rest4)) continue;
            if (new RegExp(`\\bfor\\s*\\([^)]*\\b${el}\\b`).test(rest4)) continue;
            if (new RegExp(`${el}\\s*=>`).test(rest4)) continue;
            if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${el}\\s*[,)]`).test(rest4)) continue;
            for (const cm of rest4.matchAll(new RegExp(`(?<![\\w$.])${el}((?:\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g'))) {
              const chainSegs = cm[1].slice(1).split('.');
              if (!chainSegs.length) continue;
              let mod2, prefix2, provider2;
              if (slotExports) {
                // Local is the slot target's namespace: first usage segment
                // dispatches its proven table ('default' -> '@default').
                if (chainSegs.length < 2) continue;
                const k = chainSegs[0] === 'default' ? '@default' : chainSegs[0];
                const e = slotExports.find((x) => x.name === k);
                if (!e) continue; // miss — never bind
                mod2 = e.mod; prefix2 = [...(e.prefix || []), ...chainSegs.slice(1)]; provider2 = e.provider;
                const line = text.slice(0, cm.index).split('\n').length;
                const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
                add(provider2, 'sdk-call', `${mod2} client.${prefix2.join('.')}`, { file, line, snippet });
                continue;
              }
              const line = text.slice(0, cm.index).split('\n').length;
              const snippet = (text.split('\n')[line - 1] || '').trim().slice(0, 200);
              const chain = [...entryPrefix, ...chainSegs];
              add(entryProvider, 'sdk-call', `${entryMod} client.${chain.join('.')}`, { file, line, snippet });
            }
          }
        }
        // Positional destructure of Promise.all over STORED promise variables:
        // `const [ma, mb] = await Promise.all([pa, pb]);` (Loop 247) — the
        // stored-promise twin of the inline DYN_ALL_RE form. Promise.all over
        // an array literal resolves positionally per spec, so the k-th
        // pattern element IS the module namespace object of the k-th array
        // element when that element is a guard-surviving promise variable
        // (its declaration is a literal relative import and its identity
        // holds file-wide). Soundness of the positional split requires the
        // whole statement to be provable at once: every array element must be
        // a proven promise variable OR a literal relative import() (Loop 248:
        // mixed stored/inline elements are the same positional proof — both
        // element kinds resolve to a module namespace object; any other
        // expression may contain commas and break the alignment — the whole
        // statement is honestly dropped). Statements whose elements are ALL
        // literal imports are DYN_ALL_RE territory (handled above) and are
        // skipped here to avoid double-binding.
        // The pattern must contain no nested patterns. Per element: holes
        // skip their position, defaults/rest are not pure namespace bindings
        // and drop that element. Each bound local is a bare file-level
        // identifier with no body isolation, so it inherits the full
        // second-order identity guard set (redeclaration, reassignment,
        // catch binding, for-head capture, param-shadow — any hit drops the
        // local). Misses never bind; false drops are safe.
        if (provenPv.size) {
          const PV_ALL_RE = /^[ \t]*(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*await\s+Promise\.(all|allSettled)\(\s*\[([^\]]*)\]\s*\)\s*;?[ \t]*$/gm;
          const PV_ALL_ONE = /^[ \t]*(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*await\s+Promise\.(all|allSettled)\(\s*\[([^\]]*)\]\s*\)\s*;?[ \t]*$/;
          for (const m of scan.matchAll(PV_ALL_RE)) {
            // Loop 258: pattern elements may contain a settled-value pick
            // (`{ value }` / `{ value: local }`) — the depth-aware topSplit
            // keeps the positional alignment provable, so nesting drops per
            // element instead of the whole statement (mirrors DYN_ALL_RE,
            // Loop 257). `[` inside the pattern still has no provable form
            // and drops per element below.
            // `Promise.allSettled` (Loop 253): same positional proof, but the
            // bound locals are settled RESULT OBJECTS — namespace under
            // `.value` only. Tagged wrap:'value' for extractSdkCalls.
            const wrap = m[2] === 'allSettled' ? 'value' : undefined;
            // The blanked copy proved this is real code (not comment/string),
            // but string CONTENTS are blanked in it — re-extract the element
            // list from the original text at the same offsets (blanking is
            // length-preserving) so literal import specifiers are readable.
            // If the original slice no longer matches (e.g. a `]` inside a
            // string broke the bracket shape), drop honestly.
            const om = text.slice(m.index, m.index + m[0].length).match(PV_ALL_ONE);
            if (!om) continue;
            const targets = [];
            let pure = true;
            let storedCount = 0;
            for (const part of om[3].split(',')) {
              const raw = part.trim();
              if (!raw) { targets.push(null); continue; } // trailing comma / hole
              const pv = /^[A-Za-z_$][\w$]*$/.test(raw) ? provenPv.get(raw) : undefined;
              if (pv) { storedCount++; targets.push(pv.target); continue; }
              // Mixed form (Loop 248): a literal relative import() element is
              // the same positional proof as a proven promise variable.
              const im = raw.match(/^import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)$/);
              const t = im ? resolveTarget(im[1]) : undefined;
              if (!t) { pure = false; break; } // non-provable element: whole drop
              targets.push(t);
            }
            if (!pure) continue;
            if (!storedCount) continue; // all-inline: DYN_ALL_RE territory, no double bind
            const names = topSplit(m[1]).map((p) => p.trim());
            const restA = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice(m.index + m[0].length);
            for (let i = 0; i < names.length; i++) {
              const name = names[i];
              if (!name) continue; // elision hole
              const target = targets[i];
              if (!target) continue;
              // Loop 258: settled-value pick element (stored/mixed twin of
              // the Loop 257 inline form). Only the exact single-key
              // `{ value }` / `{ value: local }` pick is provable — the
              // pick already unwrapped `.value`, so the local IS the
              // namespace (no wrap). Anything else non-identifier drops.
              let local = name;
              let elWrap = wrap;
              if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
                if (m[2] !== 'allSettled') continue; // plain all: export pick, different proof
                const pick = name.match(SETTLED_PICK_RE);
                if (!pick) continue; // default/status/rest/deeper nesting: honest drop
                local = pick[1] || 'value';
                elWrap = undefined;
              }
              if (provenPv.has(local)) continue; // self-shadow: never reason about it
              const el = local.replace(/\$/g, '\\$');
              if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${el}\\b`).test(restA)) continue;
              if (new RegExp(`(?<![.\\w$])${el}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(restA)) continue;
              if (new RegExp(`\\bcatch\\s*\\(\\s*${el}\\b`).test(restA)) continue;
              if (new RegExp(`\\bfor\\s*\\([^)]*\\b${el}\\b`).test(restA)) continue;
              if (new RegExp(`${el}\\s*=>`).test(restA)) continue;
              if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${el}\\s*[,)]`).test(restA)) continue;
              nsRoots.push({ name: local, exports: exportsByFile.get(target) || [], slots: slotsTableFor(target), wrap: elWrap });
            }
          }
          // const winner = await Promise.race([pv, import('./rel')]);
          // Stored-promise twin of the inline DYN_RACE_RE form (Loop 255).
          // race/any return a SINGLE value: when every element is either a
          // guard-surviving promise variable or a literal relative import()
          // and ALL of them resolve to the SAME target file, the awaited
          // value is that file's namespace regardless of which element
          // settles first — plain table dispatch. Divergent targets,
          // non-provable elements, holes (undefined settles race immediately
          // with a non-namespace value), and empty arrays drop the whole
          // statement. All-inline statements are DYN_RACE_RE territory
          // (handled in the earlier pass) and are skipped to avoid double
          // binding. The bound local is a bare file-level identifier and
          // inherits the full second-order identity guard set. Misses never
          // bind; false drops are safe.
          const PV_RACE_RE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+Promise\.(?:race|any)\(\s*\[([^\]]*)\]\s*\)\s*;?[ \t]*$/gm;
          const PV_RACE_ONE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+Promise\.(?:race|any)\(\s*\[([^\]]*)\]\s*\)\s*;?[ \t]*$/;
          for (const m of scan.matchAll(PV_RACE_RE)) {
            // Blanked copy proved real code; re-extract from the original at
            // the same offsets so literal import specifiers are readable
            // (blanking is length-preserving). Shape mismatch: honest drop.
            const om = text.slice(m.index, m.index + m[0].length).match(PV_RACE_ONE);
            if (!om) continue;
            const parts = om[2].split(',').map((p) => p.trim());
            let target; let pure = parts.length > 0; let storedCount = 0;
            for (const raw of parts) {
              if (!raw) { pure = false; break; } // hole/trailing comma: honest drop
              let t;
              const pv = /^[A-Za-z_$][\w$]*$/.test(raw) ? provenPv.get(raw) : undefined;
              if (pv) { storedCount++; t = pv.target; }
              else {
                const im = raw.match(/^import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)$/);
                t = im ? resolveTarget(im[1]) : undefined;
              }
              if (!t) { pure = false; break; } // non-provable element: whole drop
              if (target === undefined) target = t;
              else if (t !== target) { pure = false; break; } // divergent: winner unknown
            }
            if (!pure || !target) continue;
            if (!storedCount) continue; // all-inline: DYN_RACE_RE territory, no double bind
            const name = m[1];
            if (provenPv.has(name)) continue; // self-shadow: never reason about it
            const restA = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice(m.index + m[0].length);
            const el = name.replace(/\$/g, '\\$');
            if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${el}\\b`).test(restA)) continue;
            if (new RegExp(`(?<![.\\w$])${el}\\s*(?:[+\\-*/%&|^]|\\*\\*|&&|\\|\\||\\?\\?)?=(?!=|>)`).test(restA)) continue;
            if (new RegExp(`\\bcatch\\s*\\(\\s*${el}\\b`).test(restA)) continue;
            if (new RegExp(`\\bfor\\s*\\([^)]*\\b${el}\\b`).test(restA)) continue;
            if (new RegExp(`${el}\\s*=>`).test(restA)) continue;
            if (new RegExp(`[(,]\\s*(?:\\.\\.\\.)?${el}\\s*[,)]`).test(restA)) continue;
            nsRoots.push({ name, exports: exportsByFile.get(target) || [], slots: slotsTableFor(target) });
          }
        }
      }
      if (!externalRoots.length && !nsRoots.length) continue;
      // moduleNames deliberately empty: this pass only resolves chains rooted
      // at imported-and-proven external clients. Local provider imports in the
      // same file were already fully handled by the importFiles pass above, so
      // no surface is ever double-attributed (different roots, disjoint sets).
      const providerByMod = new Map([
        ...externalRoots.map((r) => [r.mod, r.provider]),
        ...nsRoots.flatMap((r) => [
          ...r.exports.map((x) => [x.mod, x.provider]),
          // Two-level namespace slots carry their own proven tables — their
          // providers must be attributable too (see extractSdkCalls dispatch).
          ...(r.slots ? [...r.slots.values()].flatMap((t) => t.map((x) => [x.mod, x.provider])) : []),
        ]),
      ]);
      for (const call of extractSdkCalls(text, [], { externalRoots, nsRoots })) {
        const provider = providerByMod.get(call.module);
        if (!provider) continue;
        if (call.kind !== 'sdk-call') continue;
        add(provider, 'sdk-call', `${call.module} ${call.chain}`, { file, line: call.line, snippet: call.snippet });
      }
    }
  }

  const providersOut = Object.entries(byProvider).map(([provider, bucket]) => {
    const surfaces = Object.values(bucket).sort((a, b) =>
      a.kind === b.kind ? a.surface.localeCompare(b.surface) : a.kind.localeCompare(b.kind));
    return { provider, surface_count: surfaces.length, surfaces };
  }).sort((a, b) => a.provider.localeCompare(b.provider));

  return {
    tool: 'mendapi-deps/0.1',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo: repoPath,
    files_scanned: filesScanned,
    providers_detected: providersOut.map((p) => p.provider),
    providers: providersOut,
  };
}

// ---------- --match: join inventory endpoints against monitored change anchors ----------
// Spec-diff change records carry anchors like "GET /v2/Attempts/Summary :: prop".
// A repo endpoint surface matches when its normalized path prefix-overlaps the
// anchor path (template {param} slots wildcard one segment).
export function anchorPath(sourceUrlOrTitle) {
  const m = String(sourceUrlOrTitle).match(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s:)]+)/);
  return m ? m[1] : null;
}

function pathsOverlap(repoPath_, anchorPath_) {
  const a = repoPath_.split('/').filter(Boolean);
  const b = anchorPath_.split('/').filter(Boolean);
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    if (x === y || x === '{param}' || /^\{[^}]+\}$/.test(y)) { matched++; continue; }
    return false;
  }
  // require at least 2 matched segments (or full shorter path) to avoid /v1-only overlap
  return matched >= 2 || matched === Math.max(a.length, b.length);
}

function matchAgainstDb(inventory) {
  if (!existsSync(DB_PATH)) return { error: 'no change database found — run `mendapi sync` first' };
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const changes = db.prepare(
    "SELECT id, provider, title, change_type, source_url FROM changes WHERE change_type IN ('breaking','deprecation')"
  ).all();
  db.close();

  const matches = [];
  for (const prov of inventory.providers) {
    const endpoints = prov.surfaces.filter((s) => s.kind === 'endpoint');
    if (!endpoints.length) continue;
    for (const ch of changes) {
      if (ch.provider !== prov.provider) continue;
      const ap = anchorPath(ch.title) || anchorPath(ch.source_url);
      if (!ap) continue;
      for (const ep of endpoints) {
        if (pathsOverlap(ep.surface, ap)) {
          matches.push({
            change_id: ch.id, provider: ch.provider, change_type: ch.change_type,
            change_anchor: ap, repo_endpoint: ep.surface,
            evidence: ep.sites.slice(0, 3),
          });
        }
      }
    }
  }
  return { monitored_changes_considered: changes.length, endpoint_matches: matches };
}

// ---------- --match: join sdk-call surfaces against migration pack chains ----------
// Packs may expose a `chains` list (documented SDK resource chains they
// rewrite, e.g. "kv.namespaces.values.get"). A repo sdk-call surface
// (`<module> client.a.b.method`) matches when its segment tail equals a pack
// chain — the exact same tail-anchoring the fixer uses to rewrite call sites,
// so a hit here means `mendapi fix --migration <pack>` will touch that line.
export function chainTailMatches(callChain, packChain) {
  const call = callChain.split('.').filter(Boolean); // client.a.b.method
  const target = packChain.split('.').filter(Boolean);
  if (call.length - 1 < target.length) return false; // drop the `client` root
  const tail = call.slice(call.length - target.length);
  return tail.every((seg, i) => seg === target[i]);
}

async function matchSdkCalls(inventory) {
  const { MIGRATIONS } = await import('./fixer.js');
  const matches = [];
  let chainsConsidered = 0;
  for (const [packName, pack] of Object.entries(MIGRATIONS)) {
    const hasChains = Array.isArray(pack.chains) && pack.chains.length;
    const hasControllers = Array.isArray(pack.controllers) && pack.controllers.length;
    if (!hasChains && !hasControllers) continue;
    if (hasChains) chainsConsidered += pack.chains.length;
    if (hasControllers) chainsConsidered += pack.controllers.reduce((n, c) => n + c.methods.length, 0);
    const prov = inventory.providers.find((p) => p.provider === pack.provider);
    if (!prov) continue;
    for (const s of prov.surfaces) {
      if (hasChains && s.kind === 'sdk-call') {
        const callChain = s.surface.split(' ').pop(); // "<module> client.a.b.m" -> chain
        for (const packChain of pack.chains) {
          if (chainTailMatches(callChain, packChain)) {
            matches.push({
              pack: packName, change_ids: pack.covers || [],
              provider: pack.provider, pack_chain: packChain,
              repo_sdk_call: s.surface, evidence: s.sites.slice(0, 3),
            });
          }
        }
      }
      if (hasControllers && s.kind === 'controller-call') {
        // Surface: "<module> <Ctor> <anchorVar>.<...>.<method>". A join
        // requires the constructor, the anchor variable name, and the leaf
        // method to all agree with the pack declaration — the exact triple
        // the fixer's own rewrite rules anchor on, so a hit means
        // `mendapi fix --migration <pack>` will touch that line.
        const parts = s.surface.split(' ');
        const ctor = parts[1];
        const chain = parts[2] || '';
        const segs = chain.split('.');
        if (segs.length !== 2) continue; // fixer anchors `anchorVar.method(` only
        const [root, method] = segs;
        for (const decl of pack.controllers) {
          if (decl.ctor === ctor && decl.anchor === root && decl.methods.includes(method)) {
            matches.push({
              pack: packName, change_ids: pack.covers || [],
              provider: pack.provider, pack_chain: `${decl.anchor}.${method}`,
              repo_sdk_call: s.surface, evidence: s.sites.slice(0, 3),
            });
          }
        }
      }
    }
  }
  return { pack_chains_considered: chainsConsidered, sdk_call_matches: matches };
}

// ---------- terminal output ----------
function printInventory(inv) {
  const out = [''];
  out.push('mendapi deps — API dependency inventory');
  out.push(`repo: ${inv.repo}`);
  out.push(`${inv.files_scanned} files scanned — providers: ${inv.providers_detected.join(', ') || 'none'}`);
  out.push('');
  for (const p of inv.providers) {
    out.push(`[${p.provider}] ${p.surface_count} surface${p.surface_count === 1 ? '' : 's'}`);
    for (const s of p.surfaces) {
      const first = s.sites[0];
      out.push(`  ${s.kind.padEnd(9)} ${s.surface}  (${first.file}:${first.line}${s.sites.length > 1 ? ` +${s.sites.length - 1}` : ''})`);
    }
    out.push('');
  }
  if (inv.match) {
    const m = inv.match;
    if (m.error) out.push(`match: ${m.error}`);
    else if (!m.endpoint_matches.length) out.push(`No monitored breaking changes intersect this repo's endpoint surfaces (${m.monitored_changes_considered} considered).`);
    else {
      out.push(`${m.endpoint_matches.length} monitored change(s) intersect your endpoints:`);
      for (const hit of m.endpoint_matches) {
        out.push(`  #${hit.change_id} [${hit.provider}] ${hit.change_type} ${hit.change_anchor}  <- ${hit.repo_endpoint} (${hit.evidence[0].file}:${hit.evidence[0].line})`);
      }
    }
    out.push('');
  }
  if (inv.sdk_match) {
    const m = inv.sdk_match;
    if (!m.sdk_call_matches.length) out.push(`No migration pack chains intersect this repo's SDK call chains (${m.pack_chains_considered} pack chains considered).`);
    else {
      out.push(`${m.sdk_call_matches.length} SDK call chain(s) covered by a migration pack:`);
      for (const hit of m.sdk_call_matches) {
        out.push(`  ${hit.repo_sdk_call}  -> mendapi fix --migration ${hit.pack} (change${hit.change_ids.length === 1 ? '' : 's'} #${hit.change_ids.join(', #')}) (${hit.evidence[0].file}:${hit.evidence[0].line})`);
      }
    }
    out.push('');
  }
  console.log(out.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.error('Usage: node deps.js [--repo <path>] [--json] [--out <file.json>] [--match]');
    process.exit(2);
  }
  if (!args.repo || args.repo === true) args.repo = process.cwd();
  const inventory = buildInventory(args.repo);
  if (args.match) {
    inventory.match = matchAgainstDb(inventory);
    inventory.sdk_match = await matchSdkCalls(inventory);
  }

  const json = JSON.stringify(inventory, null, 2);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    console.log(`inventory written: ${args.out}`);
  } else if (args.json) {
    console.log(json);
    console.error(`files_scanned=${inventory.files_scanned} providers=${inventory.providers_detected.length} surfaces=${inventory.providers.reduce((n, p) => n + p.surface_count, 0)}`);
    return;
  } else {
    printInventory(inventory);
  }
  console.log(`files_scanned=${inventory.files_scanned} providers=${inventory.providers_detected.length} surfaces=${inventory.providers.reduce((n, p) => n + p.surface_count, 0)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
