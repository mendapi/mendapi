#!/usr/bin/env node
// mendapi scanner — scans a codebase for usage impacted by upstream API changes.
// Zero npm dependencies: node:sqlite + node:fs.
//
// Usage:
//   node app/scanner.js [--repo /path/to/repo] [--provider stripe] [--change-id 42] [--out report.json] [--json]
//
// Zero-config: --repo defaults to the current working directory. Without --out or
// --json the scanner prints a human-readable terminal summary; --json prints the
// full JSON report to stdout; --out writes it to a file.
//
// Pipeline: load change records from the watcher DB -> detect which providers the
// repo actually uses (imports / env vars / API hosts) -> locate every usage site ->
// emit an impact report (JSON) ranking findings by change severity.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
import { DB_PATH } from './dbpath.js';

// ---------- provider signatures ----------
// Each provider: how its SDK / API shows up inside a codebase.
// `modules` are npm package names; when a provider's official Python SDK is
// imported under a *different* name (npm != pypi import name), list that
// import name in `pyModules` — matched with Python import syntax only
// (`import mod` / `from mod import ...`), never with JS require/from-string
// forms. Providers whose npm name is itself a valid Python identifier and
// equals the pypi import name (stripe, openai, plaid, twilio, anthropic,
// cloudflare) need no pyModules entry — the shared import matcher already
// covers them.
// `goModules` are official Go SDK module paths: `path` is the import path
// prefix (matched inside .go files only, quoted-string line-anchored — the
// import line is the binding proof), `pkg` is the SDK's documented root
// package identifier (Go package names are NOT mechanically derivable from
// hyphenated module paths, e.g. stripe-go -> package stripe, so the mapping
// is explicit like rbModules constants). Version segments (/v76) and
// subpackages (/charge) are handled by the deps-side binding resolver.
// `phpModules` are official PHP SDK top-level namespaces: `ns` is the root
// namespace documented by the SDK (Stripe, Twilio, Aws, ...). Matched inside
// .php files only, on `use Ns\...` statements (line-anchored binding proof)
// or fully-qualified `\Ns\Class::method(` static calls. Only OFFICIAL SDK
// namespaces are listed — community packages and overly generic roots
// (e.g. `Google`) are deliberately excluded (false-positive-first rule).
export const SIGNATURES = {
  stripe:     { modules: ['stripe'], rbModules: [{ gem: 'stripe', const: 'Stripe' }], goModules: [{ path: 'github.com/stripe/stripe-go', pkg: 'stripe' }], phpModules: [{ ns: 'Stripe' }], hosts: ['api.stripe.com'], env: ['STRIPE_'] },
  openai:     { modules: ['openai'], rbModules: [{ gem: 'openai', const: 'OpenAI' }], goModules: [{ path: 'github.com/openai/openai-go', pkg: 'openai' }, { path: 'github.com/sashabaranov/go-openai', pkg: 'openai' }], hosts: ['api.openai.com'], env: ['OPENAI_'] },
  anthropic:  { modules: ['@anthropic-ai/sdk', 'anthropic'], rbModules: [{ gem: 'anthropic', const: 'Anthropic' }], goModules: [{ path: 'github.com/anthropics/anthropic-sdk-go', pkg: 'anthropic' }], hosts: ['api.anthropic.com'], env: ['ANTHROPIC_'] },
  shopify:    { modules: ['@shopify/shopify-api'], pyModules: ['shopify'], rbModules: [{ gem: 'shopify_api', const: 'ShopifyAPI' }], phpModules: [{ ns: 'Shopify' }], hosts: ['myshopify.com', 'admin/api'], env: ['SHOPIFY_'] },
  twilio:     { modules: ['twilio'], rbModules: [{ gem: 'twilio-ruby', const: 'Twilio' }], goModules: [{ path: 'github.com/twilio/twilio-go', pkg: 'twilio' }], phpModules: [{ ns: 'Twilio' }], hosts: ['api.twilio.com'], env: ['TWILIO_'] },
  sendgrid:   { modules: ['@sendgrid/mail', '@sendgrid/client'], pyModules: ['sendgrid'], rbModules: [{ gem: 'sendgrid-ruby', const: 'SendGrid' }], goModules: [{ path: 'github.com/sendgrid/sendgrid-go', pkg: 'sendgrid' }], phpModules: [{ ns: 'SendGrid' }], hosts: ['api.sendgrid.com'], env: ['SENDGRID_'] },
  slack:      { modules: ['@slack/web-api', '@slack/bolt'], pyModules: ['slack_sdk'], rbModules: [{ gem: 'slack-ruby-client', const: 'Slack' }], goModules: [{ path: 'github.com/slack-go/slack', pkg: 'slack' }], hosts: ['slack.com/api'], env: ['SLACK_'] },
  github:     { modules: ['octokit', '@octokit/rest', '@octokit/core'], pyModules: ['github'], rbModules: [{ gem: 'octokit', const: 'Octokit' }], goModules: [{ path: 'github.com/google/go-github', pkg: 'github' }], hosts: ['api.github.com'], env: ['GITHUB_TOKEN', 'GH_TOKEN'] },
  plaid:      { modules: ['plaid'], rbModules: [{ gem: 'plaid', const: 'Plaid' }], goModules: [{ path: 'github.com/plaid/plaid-go', pkg: 'plaid' }], hosts: ['plaid.com'], env: ['PLAID_'] },
  cloudflare: { modules: ['cloudflare'], goModules: [{ path: 'github.com/cloudflare/cloudflare-go', pkg: 'cloudflare' }], hosts: ['api.cloudflare.com'], env: ['CLOUDFLARE_', 'CF_API'] },
  supabase:   { modules: ['@supabase/supabase-js'], pyModules: ['supabase'], hosts: ['supabase.co'], env: ['SUPABASE_'] },
  notion:     { modules: ['@notionhq/client'], pyModules: ['notion_client'], hosts: ['api.notion.com'], env: ['NOTION_'] },
  google:     { modules: ['googleapis', 'google-auth-library', '@google-cloud/storage', '@google-cloud/bigquery', '@google-cloud/pubsub'], pyModules: ['google.cloud'], hosts: ['googleapis.com'], env: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY', 'GCP_'] },
  aws:        { modules: ['@aws-sdk/client-s3', '@aws-sdk/client-dynamodb', '@aws-sdk/client-lambda', '@aws-sdk/client-ses', '@aws-sdk/client-sqs', 'aws-sdk'], pyModules: ['boto3', 'botocore'], phpModules: [{ ns: 'Aws' }], hosts: ['amazonaws.com'], env: ['AWS_ACCESS_KEY', 'AWS_SECRET', 'AWS_REGION'] },
  meta:       { modules: ['facebook-nodejs-business-sdk'], pyModules: ['facebook_business'], phpModules: [{ ns: 'FacebookAds' }], hosts: ['graph.facebook.com', 'graph.instagram.com'], env: ['FACEBOOK_', 'FB_APP', 'META_'] },
  paypal:     { modules: ['@paypal/paypal-server-sdk', '@paypal/checkout-server-sdk', 'paypal-rest-sdk'], pyModules: ['paypalserversdk', 'paypalrestsdk'], phpModules: [{ ns: 'PayPal' }], hosts: ['api-m.paypal.com', 'api.paypal.com', 'api-m.sandbox.paypal.com'], env: ['PAYPAL_'] },
  hubspot:    { modules: ['@hubspot/api-client'], pyModules: ['hubspot'], phpModules: [{ ns: 'HubSpot' }], hosts: ['api.hubapi.com'], env: ['HUBSPOT_'] },
  salesforce: { modules: ['jsforce', '@salesforce/core'], hosts: ['salesforce.com', 'force.com'], env: ['SALESFORCE_', 'SFDC_'] },
  vercel:     { modules: ['@vercel/sdk', '@vercel/client'], hosts: ['api.vercel.com'], env: ['VERCEL_'] },
  firebase:   { modules: ['firebase', 'firebase-admin', 'firebase/app', 'firebase/auth', 'firebase/firestore'], pyModules: ['firebase_admin'], hosts: ['firebaseio.com', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com'], env: ['FIREBASE_'] },
};

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.php', '.sh']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'vendor', '.venv', '__pycache__', 'data']);
const SEVERITY = { breaking: 'high', deprecation: 'medium', unknown: 'low', additive: 'info', 'docs-only': 'info' };

// ---------- CLI args ----------
// SDK pre-release detection (title-level): "v22.4.0-alpha.4", "v15.4.0a4",
// "v15.4.0b1", "7.2.0-rc.3", "v2.110.9-canary.0", "13.0.0-beta.3".
export function isPrereleaseTitle(title = '') {
  return /\d+\.\d+\.\d+\s*(-[0-9A-Za-z.]*(alpha|beta|rc|canary|next|dev|preview|pre)|(a|b|rc)\d+)\b/i.test(title);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

// ---------- file walking ----------
export function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && SCAN_EXTS.has(extname(name)) && st.size < 1_000_000) yield p;
  }
}

// ---------- usage detection ----------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildMatchers(provider) {
  const sig = SIGNATURES[provider];
  if (!sig) return [];
  const m = [];
  for (const mod of sig.modules) {
    const e = escapeRe(mod);
    m.push({ kind: 'import', re: new RegExp(`(require\\s*\\(\\s*['"]${e}(/|['"])|from\\s+['"]${e}(/|['"])|import\\s+['"]${e}(/|['"])|^\\s*import\\s+${e}\\b|^\\s*from\\s+${e}\\b)`, 'm'), detail: mod });
  }
  for (const mod of sig.pyModules || []) {
    // Python-only import syntax for SDKs whose pypi import name differs from
    // the npm package name (e.g. aws -> boto3, slack -> slack_sdk). Matched
    // at line start only; JS string-form imports are never consulted here.
    const e = escapeRe(mod);
    m.push({ kind: 'import', re: new RegExp(`(^\\s*import\\s+${e}\\b|^\\s*from\\s+${e}\\b)`, 'm'), detail: mod, pyOnly: true });
  }
  for (const rb of sig.rbModules || []) {
    // Ruby-only require syntax (`require 'gem'` / `require "gem"`), matched at
    // line start in .rb files only. require_relative and local paths never
    // match because the gem name is anchored between quotes with no slashes.
    const e = escapeRe(rb.gem);
    m.push({ kind: 'import', re: new RegExp(`^\\s*require\\s+['"]${e}['"]`, 'm'), detail: rb.gem, rbOnly: true });
  }
  for (const go of sig.goModules || []) {
    // Go-only import syntax, matched in .go files only. Covers both forms:
    //   import "github.com/stripe/stripe-go/v76"
    //   import ( ... stripe "github.com/stripe/stripe-go/v76" ... )
    // The quoted module path (optionally preceded by `import` and/or an alias
    // identifier, `.`, or `_`) is the line-anchored binding proof. Version
    // suffixes (/v76) and subpackages (/charge) extend the path prefix and
    // still match; the same path quoted inside a JS/Python string never
    // matches because the goOnly gate restricts this matcher to .go files.
    const e = escapeRe(go.path);
    m.push({ kind: 'import', re: new RegExp(`^\\s*(?:import\\s+)?(?:[A-Za-z_]\\w*\\s+|\\.\\s+|_\\s+)?"${e}(/|")`, 'm'), detail: go.path, goOnly: true });
  }
  for (const php of sig.phpModules || []) {
    // PHP-only namespace syntax, matched in .php files only. Two proofs:
    //   use Stripe\StripeClient;          (line-anchored use statement)
    //   \Stripe\Charge::create(...)       (fully-qualified reference — the
    //                                      leading backslash is mandatory)
    // The negative lookbehind rejects nested vendor lookalikes (App\Stripe\...)
    // — a preceding word char means the backslash is a separator inside a
    // longer namespace, not a fully-qualified root. Namespace mentions inside
    // strings without the leading `\` (e.g. "Stripe\Charge") never match.
    const e = escapeRe(php.ns);
    m.push({ kind: 'import', re: new RegExp(`(^\\s*use\\s+${e}\\\\|(?<!\\w)\\\\${e}\\\\[A-Z])`, 'm'), detail: php.ns, phpOnly: true });
    // Third proof form: relative references in files that declare NO
    // namespace. Per the PHP spec, relative names in such files resolve from
    // the global namespace, so `Stripe\Charge::create(...)` there is exactly
    // `\Stripe\Charge::create(...)`. The absence of a namespace declaration
    // is a whole-file, single-grep provable fact (phpGlobalNsOnly gate in
    // scanRepo); files that declare any namespace stay on the AST track for
    // relative refs. Call syntax is required (static `::method(` or
    // `new Ns\Class(`) so bare prose mentions never match; a line-start
    // comment guard keeps commented code out; the lookbehind rejects nested
    // vendor lookalikes (App\Stripe\...) and the FQ form (leading backslash —
    // already covered by the matcher above).
    m.push({ kind: 'import', re: new RegExp(`^(?![ \\t]*(?:\\/\\/|#|\\*|\\/\\*))[^\\n]*?((?<![\\w\\\\$])${e}(?:\\\\[A-Za-z_]\\w*)+::[A-Za-z_]\\w*\\s*\\(|\\bnew\\s+${e}(?:\\\\[A-Za-z_]\\w*)+\\s*\\()`, 'm'), detail: php.ns, phpOnly: true, phpGlobalNsOnly: true });
  }
  for (const host of sig.hosts) m.push({ kind: 'api-host', re: new RegExp(escapeRe(host), 'i'), detail: host });
  for (const env of sig.env) {
    // Context-aware env matching: a bare prefix like META_ collides with unrelated
    // identifiers (e.g. a Python constant META_RE). Only count it as env usage when
    // it appears in an actual environment-read context across the languages we scan:
    //   JS/TS:   process.env.META_APP_ID / process.env['META_APP_ID']
    //   Python:  os.environ['META_...'] / os.environ.get('META_...') / os.getenv('META_...')
    //   PHP/C:   getenv('META_...')
    //   Ruby:    ENV['META_...']
    //   Shell:   $META_... / ${META_...}
    //   dotenv:  line-start assignment META_APP_ID=...
    const e = escapeRe(env);
    m.push({
      kind: 'env-var',
      re: new RegExp(
        `(process\\.env\\.${e}|process\\.env\\[['"\`]${e}|os\\.environ\\[['"]${e}|os\\.environ\\.get\\(\\s*['"]${e}|os\\.getenv\\(\\s*['"]${e}|getenv\\(\\s*['"]${e}|ENV\\[['"]${e}|\\$\\{?${e}|^\\s*(export\\s+)?${e}[A-Z0-9_]*=)`,
        'm'
      ),
      detail: env,
    });
  }
  return m;
}

// ---------- comment masking (provider-detection precision) ----------
// The module-detection matchers below run against file text, so an import
// line quoted inside a COMMENT minted a provider detection: `// old: import
// stripe`, a /* legacy */ block holding the pre-migration import, and a
// Ruby =begin block all flagged a clean repo as a consumer — and every
// change in that provider's feed then surfaced as a false impact
// (probe-verified). Migration notes quoting the old import are exactly what
// upgrade PRs leave behind, so this is a daily false-positive carrier at the
// PROVIDER level (worse than a single surface).
// Semantics: COMMENT content masks (blanked offset-preserving, line numbers
// keep); Python TRIPLE-QUOTED bodies mask too — they are the language's
// prose container (docstrings park example imports; same adjudication as
// the deps.js masker, Loop 273). Ordinary string content and JS template
// literals / Go raw strings copy verbatim: those are evidence carriers
// (`require('stripe')`, real fetch URLs like `https://api.github.com/...`
// in template literals — fleet-verified must keep matching); they are
// tracked only so `#` / `//` inside them never open a phantom comment.
// JS-family regex literals are tracked (Loop 294): a pattern like
// `/foo\/*bar/` used to open a phantom block comment that blacked out
// every real import below it in the file (provider-level false negative,
// probe-verified), and `/^\/\//` swallowed the rest of its own line.
// Expression-position adjudication mirrors deps.js jsRegexPos; pattern
// content masks (prose — lookalike imports inside never detect), and
// crucially `//` / `/*` inside a pattern never open a comment.
// Deliberately NOT handled (recorded, fail-safe direction is a rare miss
// never a phantom finding): host URLs inside Python triple-quoted HTML
// templates (masked with the docstring body — prose container wins).
function maskFileComments(text, file) {
  const isPy = file.endsWith('.py');
  const isRb = file.endsWith('.rb');
  const isGo = file.endsWith('.go');
  const isPhp = file.endsWith('.php');
  const isSh = file.endsWith('.sh');
  const isJsFamily = !isPy && !isRb && !isGo && !isPhp && !isSh;
  // expression-position adjudicator for `/` (regex vs division) — mirrors
  // deps.js jsRegexPos: regex after nothing, an operator/opener, or an
  // expression keyword; division after an operand.
  const jsRegexPos = (buf) => {
    const t = buf.replace(/\s+$/, '');
    if (!t) return true;
    const c = t[t.length - 1];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(c)) return true;
    const kw = t.match(/([A-Za-z_$][\w$]*)$/);
    if (kw && ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw'].includes(kw[1])) {
      return true;
    }
    return false;
  };
  // Ruby regex-vs-division adjudicator (Loop 303) — mirrors deps.js
  // rbRegexPos (Loop 286): `/` after nothing, an operator/opener, or an
  // expression keyword opens a regex; after an operand it is division.
  const RB_RX_KW = new Set(['return', 'and', 'or', 'not', 'when', 'if', 'unless', 'while', 'until', 'case', 'then', 'do', 'else', 'elsif', 'begin', 'rescue', 'ensure', 'yield', 'break', 'next']);
  const rbRegexPos = (buf) => {
    const t = buf.replace(/\s+$/, '');
    if (!t) return true;
    const c = t[t.length - 1];
    if (/[A-Za-z0-9_]/.test(c)) {
      const kw = t.match(/([A-Za-z_]\w*)$/);
      return !!kw && RB_RX_KW.has(kw[1]);
    }
    return '(,=[{;|&!<>+-*%?:^~'.includes(c);
  };
  const lines = text.split('\n');
  const out = new Array(lines.length);
  // cross-line state
  let block = false;    // JS/Go/PHP /* */ block
  let pyTriple = null;  // "'''" | '"""' — content KEPT (string, not comment)
  let rbBlock = false;  // =begin/=end
  let rawStr = false;   // Go raw string / JS template literal — content KEPT
  let phpDoc = null;    // PHP heredoc/nowdoc closer id — body MASKED (prose container, mirrors deps.js phpMaskLine)
  // Ruby heredoc bodies are prose containers too (Loop 301): a migration
  // note quoting the old `require 'stripe'` / ENV bootstrap inside a
  // `<<~DOC` body flagged a clean repo as a consumer — provider-level
  // false positive, probe-verified live (same family as the PHP heredoc,
  // Loop 300). Multiple openers on one line queue FIFO per Ruby grammar
  // (`build(<<~SQL, <<~DOC)` — bodies arrive back-to-back). Opener forms
  // mirror deps.js: bare UPPERCASE id or a quoted id with the quote glued
  // to `<<[~-]?` (with a space, `arr << 'ITEM'` is a shift/push, never a
  // heredoc). Openers inside strings/comments cannot enqueue: the string
  // branch consumes quoted content atomically and `#` blanks to EOL before
  // the opener scan runs. Interpolation slots inside bodies are masked with
  // the body (fail-safe: a real call inside `#{}` in a heredoc is a rare
  // honest miss, never a phantom finding — recorded).
  const rbHdQ = [];     // pending Ruby heredoc terminator ids, FIFO
  // Ruby percent literals (Loop 302): `%q(...)` / `%Q{...}` / `%w[...]` and
  // friends are string/array literals by Ruby grammar and the idiomatic
  // container for multi-line doc snippets — a migration note quoting the
  // old `require 'stripe'` + ENV bootstrap inside `%q( )` flagged a clean
  // repo as a consumer (probe-verified live; same provider-level family as
  // the heredoc, Loop 301; deps.js has masked these since Loop 271).
  // Content is masked as prose. Lettered forms are literals unless the `%`
  // is glued to an operand (`a%q(x)` lexes as modulo); bare `%` is a
  // literal only when nothing operand-like precedes it (`total % (count)`
  // stays modulo). Paired delimiters nest per Ruby grammar; `%r` gets the
  // char-class suspension from Loop 288 (deps.js) unless the delimiter IS
  // brackets. `#{ }` interpolation slots are masked with the body
  // (fail-safe: a real call inside a slot is a rare honest miss, never a
  // phantom finding — recorded). NOTE: unlike plain quoted strings (kept
  // verbatim as evidence), percent bodies are treated as prose containers —
  // a real host URL inside `%q()` is a rare accepted miss, mirroring the
  // heredoc/triple-quote adjudication (Loop 293/300/301).
  const RB_PCT_PAIR = { '(': ')', '[': ']', '{': '}', '<': '>' };
  let rbPct = null;     // { close, open, depth, rxcls? } — carries across lines
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let buf = '';
    let j = 0;
    if (isRb && !rbPct) {
      // (Loop 302: skipped while a percent-literal body is open — a body
      // line starting with `=begin` is string content, not a comment.)
      // Ruby heredoc body (Loop 301): checked BEFORE =begin — a body line
      // starting with `=begin` is string content, not a comment marker.
      if (rbHdQ.length) {
        if (new RegExp(`^\\s*${rbHdQ[0]}\\s*$`).test(line)) { rbHdQ.shift(); out[li] = line; continue; }
        out[li] = ' '.repeat(line.length);
        continue;
      }
      if (rbBlock) {
        if (/^=end\b/.test(line)) rbBlock = false;
        out[li] = ' '.repeat(line.length);
        continue;
      }
      if (/^=begin\b/.test(line)) { rbBlock = true; out[li] = ' '.repeat(line.length); continue; }
    }
    if (isPhp && phpDoc) {
      // heredoc/nowdoc body: pure prose (migration notes quoting old
      // `use`/`new` lines minted provider-level false positives — probed
      // live, Loop 300). Closer line is an identifier + `;`/`)` — kept.
      if (new RegExp(`^[ \\t]*${phpDoc}(?![A-Za-z0-9_])`).test(line)) { phpDoc = null; out[li] = line; continue; }
      out[li] = ' '.repeat(line.length);
      continue;
    }
    while (j < line.length) {
      if (rbPct) {
        // percent-literal body: prose — mask until the closing delimiter
        // (paired delimiters nest; escapes skip; %r char class suspends)
        const ch = line[j];
        if (ch === '\\') { const step = Math.min(2, line.length - j); buf += ' '.repeat(step); j += step; continue; }
        if (rbPct.rxcls !== undefined) {
          if (!rbPct.rxcls && ch === '[') { rbPct.rxcls = true; buf += ' '; j++; continue; }
          if (rbPct.rxcls) {
            if (ch === ']') rbPct.rxcls = false;
            buf += ' '; j++;
            continue;
          }
        }
        if (rbPct.open && ch === rbPct.open) { rbPct.depth++; buf += ' '; j++; continue; }
        if (ch === rbPct.close) {
          if (rbPct.depth) { rbPct.depth--; buf += ' '; j++; continue; }
          rbPct = null; buf += ch; j++;
          continue;
        }
        buf += ' '; j++;
        continue;
      }
      if (pyTriple) {
        const end = line.indexOf(pyTriple, j);
        if (end === -1) { buf += ' '.repeat(line.length - j); j = line.length; break; }
        buf += ' '.repeat(end - j) + pyTriple; j = end + 3; pyTriple = null; continue;
      }
      if (block) {
        const end = line.indexOf('*/', j);
        if (end === -1) { buf += ' '.repeat(line.length - j); j = line.length; break; }
        buf += ' '.repeat(end - j + 2); j = end + 2; block = false; continue;
      }
      if (rawStr) {
        const end = line.indexOf('`', j);
        if (end === -1) { buf += line.slice(j); j = line.length; break; }
        buf += line.slice(j, end + 1); j = end + 1; rawStr = false; continue;
      }
      const ch = line[j];
      if (isPy && (ch === '"' || ch === "'") && line.startsWith(ch + ch + ch, j)) {
        pyTriple = ch + ch + ch; buf += pyTriple; j += 3; continue;
      }
      if (isPhp && ch === '<' && line.slice(j, j + 3) === '<<<') {
        // heredoc/nowdoc opener — PHP grammar requires it to end the line
        const hm = line.slice(j).match(/^<<<[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))[ \t]*\r?$/);
        if (hm) { phpDoc = hm[1] || hm[2] || hm[3]; buf += line.slice(j); j = line.length; break; }
        buf += ch; j++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // string literal: copy verbatim (evidence lives here), honor escapes
        buf += ch; j++;
        while (j < line.length) {
          if (line[j] === '\\' && !isSh) { buf += line.slice(j, j + 2); j += 2; continue; }
          buf += line[j];
          if (line[j] === ch) { j++; break; }
          j++;
        }
        continue;
      }
      if ((isGo || isJsFamily) && ch === '`') { buf += '`'; j++; rawStr = true; continue; }
      if ((isPy || isRb || isSh) && ch === '#') {
        // shell: `#` mid-word ($#, a#b) is not a comment
        if (isSh && j > 0 && !/\s/.test(line[j - 1])) { buf += ch; j++; continue; }
        buf += ' '.repeat(line.length - j); j = line.length; break;
      }
      if (isRb && ch === '<' && line[j + 1] === '<') {
        // Ruby heredoc opener at code position (Loop 301). Quote glued to
        // `<<[~-]?` (else `arr << 'ITEM'` is shift/push); bare id must be
        // UPPERCASE (`a << b` shift must never open a phantom body, which
        // would blackout the rest of the file — Loop 269 shape in deps.js).
        const hm = line.slice(j).match(/^<<[~-]?(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Z_][A-Z0-9_]*)\b)/);
        if (hm) { rbHdQ.push(hm[1] || hm[2] || hm[3]); buf += hm[0]; j += hm[0].length; continue; }
        buf += ch; j++;
        continue;
      }
      if (isRb && ch === '/' && rbRegexPos(buf)) {
        // Ruby regex literal at expression position (Loop 303). deps.js has
        // masked these since Loop 286; the scanner layer was still naked:
        // a URL-guard pattern like `/api.stripe.com/` minted an api-host
        // provider detection on a clean repo (probe-verified live —
        // provider-level false positive), and a `#` inside a pattern
        // (`/v1#frag/`) opened a phantom comment that swallowed real code
        // after it on the same line (false negative). Pattern content masks
        // as prose; `[...]` char class suspends the closer; escapes skip;
        // flags consume with the closer. Interpolation `#{}` slots mask
        // with the pattern (fail-safe: rare honest miss, never a phantom —
        // same adjudication as heredoc/percent bodies). Unterminated
        // patterns mask to end of line only (no cross-line carry — the
        // deps.js Loop 286 fail-safe for multi-line /x regexes).
        buf += '/'; j++;
        let inClass = false;
        while (j < line.length) {
          const rc = line[j];
          if (rc === '\\') { const step = Math.min(2, line.length - j); buf += ' '.repeat(step); j += step; continue; }
          if (rc === '[') { inClass = true; buf += ' '; j++; continue; }
          if (rc === ']') { inClass = false; buf += ' '; j++; continue; }
          if (rc === '/' && !inClass) {
            buf += '/'; j++;
            while (j < line.length && /[a-z]/.test(line[j])) { buf += line[j]; j++; }
            break;
          }
          buf += ' '; j++;
        }
        continue;
      }
      if (isRb && ch === '%') {
        // Ruby percent-literal opener at code position (Loop 302). Mirrors
        // deps.js Loop 271 adjudication: lettered forms (%q %Q %w %W %i %I
        // %s %x %r) are literals unless the `%` is glued to an operand
        // (`a%q(x)` is modulo); bare `%` is a literal only when nothing
        // operand-like precedes it (checked on buf = masked text so far,
        // whose code chars are position-faithful).
        const pm = /^%([qQwWiIsxr]?)([^\sA-Za-z0-9])/.exec(line.slice(j));
        if (pm) {
          const t = buf.replace(/\s+$/, '');
          const prevCh = j > 0 ? line[j - 1] : '';
          const prevNs = t ? t[t.length - 1] : '';
          const operand = (c) => /[\w)\]}"']/.test(c);
          const isLit = pm[1] ? !operand(prevCh) : !operand(prevNs);
          if (isLit) {
            const open = pm[2];
            const paired = Object.prototype.hasOwnProperty.call(RB_PCT_PAIR, open);
            rbPct = {
              close: paired ? RB_PCT_PAIR[open] : open,
              open: paired ? open : null,
              depth: 0,
              ...(pm[1] === 'r' && open !== '[' ? { rxcls: false } : {}),
            };
            buf += pm[0][0] + ' '.repeat(pm[0].length - 1);
            j += pm[0].length;
            continue;
          }
        }
        buf += ch; j++;
        continue;
      }
      if (isPhp && ch === '#') { buf += ' '.repeat(line.length - j); j = line.length; break; }
      if (!isPy && !isRb && !isSh && ch === '/' && line[j + 1] === '/') {
        buf += ' '.repeat(line.length - j); j = line.length; break;
      }
      if (!isPy && !isRb && !isSh && ch === '/' && line[j + 1] === '*') {
        block = true; buf += '  '; j += 2; continue;
      }
      // JS-family regex literal (Loop 294): at expression position a `/`
      // opens a regex, not division — mask the pattern (prose) and keep
      // `//` / `/*` inside it from opening a phantom comment (which used
      // to black out every real import below, provider-level miss).
      // Adjudication mirrors deps.js jsRegexPos; unterminated pattern
      // masks to end of line (fail-safe: rare miss, never a phantom).
      if (isJsFamily && ch === '/' && jsRegexPos(buf)) {
        buf += '/'; j++;
        let inClass = false;
        while (j < line.length) {
          const rc = line[j];
          if (rc === '\\') { buf += '  '; j += 2; continue; }
          if (rc === '[') { inClass = true; buf += ' '; j++; continue; }
          if (rc === ']') { inClass = false; buf += ' '; j++; continue; }
          if (rc === '/' && !inClass) {
            buf += '/'; j++;
            while (j < line.length && /[a-z]/.test(line[j])) { buf += line[j]; j++; }
            break;
          }
          buf += ' '; j++;
        }
        continue;
      }
      buf += ch; j++;
    }
    out[li] = buf;
  }
  return out;
}

export function scanRepo(repoPath, providers) {
  const matchersByProvider = Object.fromEntries(providers.map((p) => [p, buildMatchers(p)]));
  const findings = []; // { provider, file, line, kind, detail, snippet }
  let filesScanned = 0;
  for (const file of walk(repoPath)) {
    filesScanned++;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const rawLines = text.split('\n');
    const lines = maskFileComments(text, file);
    text = lines.join('\n');
    for (const [provider, matchers] of Object.entries(matchersByProvider)) {
      const isPy = file.endsWith('.py');
      const isRb = file.endsWith('.rb');
      const isGo = file.endsWith('.go');
      const isPhp = file.endsWith('.php');
      // A PHP file "declares no namespace" is a single whole-file fact:
      // any `namespace Foo;` / `namespace Foo {` statement puts relative
      // references on the AST track (they resolve against that namespace).
      const phpHasNs = isPhp && /^\s*namespace\s+[A-Za-z_]/m.test(text);
      for (const matcher of matchers) {
        if (matcher.pyOnly && !isPy) continue;
        if (matcher.rbOnly && !isRb) continue;
        if (matcher.goOnly && !isGo) continue;
        if (matcher.phpOnly && !isPhp) continue;
        if (matcher.phpGlobalNsOnly && phpHasNs) continue;
        if (!matcher.re.test(text)) continue;
        const lineRe = new RegExp(matcher.re.source, matcher.re.flags.replace('m', ''));
        for (let i = 0; i < lines.length; i++) {
          if (lineRe.test(lines[i])) {
            findings.push({
              provider, kind: matcher.kind, detail: matcher.detail,
              file: relative(repoPath, file), line: i + 1,
              snippet: rawLines[i].trim().slice(0, 200),
            });
          }
        }
      }
    }
  }
  return { findings, filesScanned };
}

// ---------- symbol-level precision matching ----------
// Extract code-like symbols from a change record (title + raw excerpt) so we can
// check whether the repo actually touches the changed surface, not just the provider.
const SYMBOL_STOPWORDS = new Set([
  // generic prose / changelog words that pass the identifier regexes
  'the', 'and', 'for', 'now', 'new', 'with', 'from', 'this', 'that', 'are', 'was',
  'breaking', 'changes', 'change', 'major', 'minor', 'patch', 'bug', 'fixes', 'fix',
  'full', 'changelog', 'features', 'feature', 'support', 'version', 'release',
  'node', 'nodejs', 'javascript', 'typescript', 'types', 'type', 'api', 'sdk',
  'string', 'number', 'boolean', 'object', 'array', 'error', 'http', 'https',
  'readme', 'docs', 'documentation', 'deprecated', 'removed', 'added', 'updated',
  // language / runtime builtins — matching these proves nothing about the changed surface
  'eventemitter', 'promise', 'buffer', 'response', 'request', 'headers', 'console',
  'process', 'require', 'import', 'export', 'module', 'exports', 'default',
  'timeout', 'callback', 'options', 'config', 'client', 'server', 'stream',
  // provider brand names — a change record almost always mentions its own product
  // name ("GitHub", "OpenAI"...); matching that word in a repo proves the provider
  // is referenced, never that the *changed surface* is used. Counting it as a
  // symbol hit inflates confidence to high on prose/comment mentions.
  'github', 'openai', 'stripe', 'anthropic', 'claude', 'shopify', 'twilio',
  'sendgrid', 'slack', 'plaid', 'cloudflare', 'supabase', 'notion', 'google',
  'amazon', 'meta', 'facebook', 'instagram', 'paypal', 'hubspot', 'salesforce',
  'vercel', 'firebase', 'ghes',
]);

function extractChangeSymbols(change) {
  const text = `${change.title || ''}\n${change.raw_excerpt || ''}\n${change.migration_hint || ''}`;
  const symbols = new Set();
  const push = (s) => {
    const t = s.trim();
    if (t.length < 4 || t.length > 80) return;
    if (SYMBOL_STOPWORDS.has(t.toLowerCase())) return;
    if (/^\d+$/.test(t)) return;
    symbols.add(t);
  };
  // scoped / plain package names: @slack/webhook, stripe-node
  for (const m of text.matchAll(/@[a-z0-9-]+\/[a-z0-9._-]+/g)) push(m[0]);
  // camelCase / PascalCase identifiers: IncomingWebhookHTTPError, statusCode, withOptions
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) push(m[0]);
  for (const m of text.matchAll(/\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g)) push(m[0]);
  // dotted member paths: Stripe.HttpClient, chat.completions.create
  for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g)) {
    if (!/^\d/.test(m[0]) && !/\.(md|json|yml|yaml|txt|com|org|io)$/i.test(m[0])) push(m[0]);
  }
  // snake_case identifiers: max_network_retries
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) push(m[0]);
  // backtick-quoted inline code
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) push(m[1]);
  return [...symbols];
}

// For one impact: scan the usage files for the change's symbols.
// Returns { matched_symbols, symbol_sites } — evidence that the changed surface is used.
// Whole-symbol matching: `getR` (a truncated excerpt fragment) must NOT match
// `getRelatedArticles`. Word chars on either side of the candidate disqualify it.
function buildSymbolRegex(sym) {
  const e = escapeRe(sym);
  // identifier boundary: not preceded/followed by another identifier character
  return new RegExp(`(?<![\\w$])${e}(?![\\w$])`);
}

function matchSymbols(repoPath, change, usageSites) {
  const symbols = extractChangeSymbols(change);
  if (!symbols.length) return { symbols_extracted: 0, matched_symbols: [], symbol_sites: [] };
  const symbolRes = symbols.map((sym) => ({ sym, re: buildSymbolRegex(sym) }));
  const files = [...new Set(usageSites.map((u) => u.file))];
  const matched = new Set();
  const symbolSites = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(repoPath, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (const { sym, re } of symbolRes) {
      if (!re.test(text)) continue;
      matched.add(sym);
      for (let i = 0; i < lines.length && symbolSites.length < 100; i++) {
        if (re.test(lines[i])) {
          symbolSites.push({ file, line: i + 1, symbol: sym, snippet: lines[i].trim().slice(0, 200) });
        }
      }
    }
  }
  return { symbols_extracted: symbols.length, matched_symbols: [...matched], symbol_sites: symbolSites };
}

// ---------- monorepo sub-API granularity ----------
// google/aws SDK repos are monorepos: one release feed carries changes for hundreds
// of sub-APIs (e.g. "youtube: v33.0.0", "client-securityhub: ..."). A repo that uses
// the Google Analytics API is NOT impacted by a YouTube major bump. When a change
// names identifiable sub-APIs, require the repo's usage files to reference at least
// one of them; otherwise the impact is filtered out (counted in the report).
const SUB_API_PROVIDERS = new Set(['google', 'aws']);

function extractSubApis(change) {
  const out = new Set();
  if (change.provider === 'google') {
    // release titles look like "youtube: v33.0.0" / "walletobjects: v13.0.0"
    const m = (change.title || '').match(/^([a-z][a-z0-9_]*)\s*:\s*v?\d/i);
    if (m) out.add(m[1].toLowerCase());
  } else if (change.provider === 'aws') {
    // aws-sdk-js-v3 excerpts name affected packages as "client-securityhub", "client-redshift"...
    for (const m of `${change.title || ''}\n${change.raw_excerpt || ''}`.matchAll(/\bclient-([a-z0-9-]+)\b/g)) {
      out.add(m[1].toLowerCase());
    }
  }
  return [...out];
}

function repoUsesSubApi(repoPath, usageSites, subApis, provider) {
  const files = [...new Set(usageSites.map((u) => u.file))];
  const matched = new Set();
  for (const file of files) {
    let text;
    try { text = readFileSync(join(repoPath, file), 'utf8').toLowerCase(); } catch { continue; }
    for (const sub of subApis) {
      if (matched.has(sub)) continue;
      const hit = provider === 'aws'
        // usage shows up as @aws-sdk/client-s3 imports (or the bare package name)
        ? text.includes(`client-${sub}`)
        // google usage: google.youtube(...), youtube.googleapis.com, /auth/youtube scope,
        // @google-cloud/youtube — an identifier-boundary match inside already-flagged
        // google usage files covers all of these forms.
        : new RegExp(`(?<![\\w$])${escapeRe(sub)}(?![\\w$])`).test(text);
      if (hit) matched.add(sub);
    }
  }
  return [...matched];
}

// ---------- terminal output ----------
const TTY_COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (TTY_COLORS ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);
const cyan = (s) => c('36', s);

const CONF_LABEL = {
  high: red('HIGH  '),
  medium: yellow('MEDIUM'),
  low: dim('LOW   '),
};

function printTerminalReport(report, elapsedMs) {
  const out = [];
  out.push('');
  out.push(bold('mendapi scan'));
  out.push(dim(`repo: ${report.repo}`));
  out.push(dim(`${report.files_scanned} files scanned in ${(elapsedMs / 1000).toFixed(1)}s — providers detected: ${report.providers_detected.join(', ') || 'none'}`));
  out.push('');

  if (!report.impacts_found) {
    if (report.providers_detected.length) {
      out.push(green('No breaking changes hit your usage.'));
      out.push(dim(`${report.changes_considered} upstream changes considered${report.sub_api_filtered ? `, ${report.sub_api_filtered} filtered (unrelated sub-APIs)` : ''}.`));
    } else {
      out.push(green('No monitored API providers detected in this repo.'));
    }
    out.push('');
    console.log(out.join('\n'));
    return;
  }

  const byConf = { high: 0, medium: 0, low: 0 };
  for (const im of report.impacts) byConf[im.confidence] = (byConf[im.confidence] || 0) + 1;
  const summary = [
    byConf.high ? red(`${byConf.high} high`) : '',
    byConf.medium ? yellow(`${byConf.medium} medium`) : '',
    byConf.low ? dim(`${byConf.low} low`) : '',
  ].filter(Boolean).join(dim(' / '));
  out.push(`${bold(String(report.impacts_found))} potential impact${report.impacts_found === 1 ? '' : 's'} (${summary} confidence)`);
  out.push('');

  const shown = report.impacts.filter((im) => im.confidence !== 'low');
  const hidden = report.impacts.length - shown.length;
  // Terminal render cap: a repo with one generic SDK import and zero symbol
  // matches can accumulate thousands of medium hits (every breaking change of
  // that provider). Dumping them all makes the first-run report unreadable —
  // the terminal view is a summary, the full data always lives in --json/--out.
  // High-confidence hits are never capped (they are the actionable core).
  const MAX_TERMINAL_IMPACTS = 25;
  let list = shown.length ? shown : report.impacts.slice(0, 5);
  let capped = 0;
  if (list.length > MAX_TERMINAL_IMPACTS) {
    const high = list.filter((im) => im.confidence === 'high');
    const rest = list.filter((im) => im.confidence !== 'high');
    const budget = Math.max(MAX_TERMINAL_IMPACTS - high.length, 0);
    capped = rest.length - budget;
    list = [...high, ...rest.slice(0, budget)];
  }
  for (const im of list) {
    const ch = im.change;
    out.push(`${CONF_LABEL[im.confidence]} ${bold(`[${ch.provider}]`)} ${ch.title}`);
    out.push(`       ${dim(`${ch.type} · ${ch.source_type} · ${ch.source_url}`)}`);
    const sites = im.symbol_sites.length ? im.symbol_sites : im.usage_sites;
    for (const s of sites.slice(0, 3)) {
      out.push(`       ${cyan(`${s.file}:${s.line}`)}  ${dim((s.symbol || s.detail || '').slice(0, 60))}`);
    }
    if (sites.length > 3) out.push(`       ${dim(`... and ${sites.length - 3} more sites`)}`);
    out.push('');
  }
  if (capped > 0) {
    out.push(dim(`${capped} more medium-confidence impact${capped === 1 ? '' : 's'} not shown — use --json or --out for the full report.`));
    out.push('');
  }
  if (shown.length && hidden > 0) {
    out.push(dim(`${hidden} low-confidence impact${hidden === 1 ? '' : 's'} hidden — use --json or --out for the full report.`));
    out.push('');
  }
  out.push(dim('Next: mendapi review <report> --pending      (semantic review of medium hits)'));
  out.push(dim('      mendapi fix --from-report <report>     (preview the fix as a local diff)'));
  out.push('');
  console.log(out.join('\n'));
}

// Funnel tail: a plain string, printed after the report unless --quiet.
// No network code here — this is informational text only.
function printHostedHint() {
  const lines = [
    dim('Tip: this scan is a snapshot. Hosted monitoring — continuous watch on'),
    dim('these providers with alerts the moment a breaking change lands — is in'),
    dim('the works. Join the waitlist -> https://mendapi.com'),
    '',
  ];
  console.log(lines.join('\n'));
}

// ---------- main ----------
function main() {
  const started = Date.now();
  const args = parseArgs(process.argv);
  if (args.help) {
    console.error('Usage: mendapi scan [--repo <path>] [--provider <name>] [--change-id <id>] [--out <file.json>] [--json] [--quiet] [--include-prereleases]');
    process.exit(2);
  }
  // Zero-config default: scan the current working directory.
  if (!args.repo || args.repo === true) args.repo = process.cwd();
  if (!existsSync(DB_PATH)) {
    console.error('No change database found yet.');
    console.error('Run `mendapi sync` first to fetch the latest API change feed (one network call to provider release channels), then re-run `mendapi scan`.');
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  // 1. pick relevant changes
  let changes;
  if (args['change-id']) {
    changes = db.prepare('SELECT * FROM changes WHERE id = ?').all(Number(args['change-id']));
  } else if (args.provider) {
    changes = db.prepare("SELECT * FROM changes WHERE provider = ? AND change_type IN ('breaking','deprecation') ORDER BY effective_date DESC").all(args.provider);
  } else {
    changes = db.prepare("SELECT * FROM changes WHERE change_type IN ('breaking','deprecation') ORDER BY effective_date DESC").all();
  }
  db.close();

  // 2. scan repo for usage of the providers those changes belong to
  const providers = [...new Set(changes.map((c) => c.provider))];
  const { findings, filesScanned } = scanRepo(args.repo, providers.length ? providers : Object.keys(SIGNATURES));

  // 3. join: change x usage -> impact entries
  const usageByProvider = {};
  for (const f of findings) (usageByProvider[f.provider] ||= []).push(f);

  let subApiFiltered = 0;
  const impacts = changes
    .filter((c) => usageByProvider[c.provider]?.length)
    .filter((c) => {
      // monorepo noise gate: if the change names sub-APIs, the repo must use one of them
      if (!SUB_API_PROVIDERS.has(c.provider)) return true;
      const subApis = extractSubApis(c);
      if (!subApis.length) return true; // no sub-API identifiable — keep, confidence layer handles it
      const used = repoUsesSubApi(args.repo, usageByProvider[c.provider], subApis, c.provider);
      if (used.length) { c._sub_apis = subApis; c._sub_apis_matched = used; return true; }
      subApiFiltered++;
      return false;
    })
    .map((c) => {
      const usageSites = usageByProvider[c.provider];
      // symbol-level precision pass: does the repo touch the changed surface itself?
      const sym = matchSymbols(args.repo, c, usageSites);
      // usage-kind evidence gate, keyed by change source type:
      // - SDK release feeds: a breaking SDK change can only hit a repo that actually
      //   imports the SDK. Env-var or API-host hits alone are circumstantial (e.g.
      //   VERCEL_GIT_COMMIT_SHA on a repo that never imports @vercel/sdk) -> cap low.
      // - Changelog sources (source_repo 'changelog:<url>'): these describe API
      //   endpoint-level changes, which hit any client of the HTTP API regardless of
      //   SDK usage — a direct api-host hit IS valid evidence there.
      const usageKinds = [...new Set(usageSites.map((u) => u.kind))].sort();
      const isChangelogSource = String(c.source_repo || '').startsWith('changelog:');
      // Spec-diff sources (specingest.js) also describe API endpoint-level
      // changes anchored to the HTTP surface itself — same evidence rules as
      // changelog sources: a direct api-host hit is valid evidence.
      const isSpecDiffSource = String(c.source_repo || '').startsWith('spec-diff:');
      const isEndpointLevel = isChangelogSource || isSpecDiffSource;
      const hasEvidence = usageKinds.includes('import')
        || (isEndpointLevel && usageKinds.includes('api-host'));
      // confidence: high = changed symbols found in usage files; medium = source-valid
      // usage evidence but no changed symbol matched; low = neither.
      let confidence = sym.matched_symbols.length ? 'high'
        : (sym.symbols_extracted && hasEvidence) ? 'medium' : 'low';
      // Pre-release gate: an SDK pre-release (alpha/beta/rc/canary) only ships to
      // users who explicitly opted into that channel — for everyone else it is
      // noise, not an actionable breaking change. Cap confidence: symbol-matched
      // pre-releases drop to medium (real surface touched, change not stable yet),
      // everything else drops to low (hidden from the default terminal report).
      // Opt back in with --include-prereleases. Changelog sources are exempt
      // (endpoint-level changes go live for everyone at once).
      const prerelease = !isEndpointLevel && isPrereleaseTitle(c.title);
      if (prerelease && !args['include-prereleases']) {
        confidence = confidence === 'high' ? 'medium' : 'low';
      }
      return {
        change: {
          id: c.id, provider: c.provider, title: c.title, type: c.change_type,
          severity: SEVERITY[c.change_type] || 'low',
          effective_date: c.effective_date, source_url: c.source_url,
          source_type: isSpecDiffSource ? 'spec-diff' : (isChangelogSource ? 'changelog' : 'sdk-release'),
        },
        confidence,
        ...(prerelease ? { prerelease: true } : {}),
        usage_kinds: usageKinds,
        ...(c._sub_apis ? { sub_apis: c._sub_apis, sub_apis_matched: c._sub_apis_matched } : {}),
        symbols_extracted: sym.symbols_extracted,
        matched_symbols: sym.matched_symbols,
        symbol_sites: sym.symbol_sites,
        usage_sites: usageSites,
      };
    })
    .sort((a, b) => {
      const sev = ['high', 'medium', 'low', 'info'];
      const bySev = sev.indexOf(a.change.severity) - sev.indexOf(b.change.severity);
      if (bySev) return bySev;
      const conf = ['high', 'medium', 'low'];
      return conf.indexOf(a.confidence) - conf.indexOf(b.confidence);
    });

  const report = {
    tool: 'mendapi-scanner/0.5',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repo: args.repo,
    files_scanned: filesScanned,
    providers_detected: Object.keys(usageByProvider).sort(),
    changes_considered: changes.length,
    sub_api_filtered: subApiFiltered,
    impacts_found: impacts.length,
    impacts,
  };

  const elapsed = Date.now() - started;
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    printTerminalReport(report, elapsed);
    console.log(`report written: ${args.out}`);
  } else if (args.json) {
    console.log(json);
    console.error(`\nfiles_scanned=${filesScanned} providers_detected=${report.providers_detected.join(',') || 'none'} impacts=${impacts.length}`);
    return;
  } else {
    printTerminalReport(report, elapsed);
  }
  if (!args.quiet) printHostedHint();
  console.log(`files_scanned=${filesScanned} providers_detected=${report.providers_detected.join(',') || 'none'} impacts=${impacts.length}`);
}

// Run main() only when executed directly (node app/scanner.js). Importing this
// module (e.g. deps.js reusing SIGNATURES/scanRepo) must have no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
