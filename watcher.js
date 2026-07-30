#!/usr/bin/env node
// mendapi watcher — collects upstream API change events into SQLite.
// Zero npm dependencies: node:sqlite + global fetch.
// Sources (v1): GitHub Releases Atom feeds of official SDK repos per provider.
// Classification (v1): deterministic keyword heuristic (breaking / deprecation / additive / docs-only / unknown).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'sentinel.db');

// provider -> list of GitHub repos whose releases we watch
const SOURCES = {
  stripe:     ['stripe/stripe-node', 'stripe/stripe-python'],
  openai:     ['openai/openai-node', 'openai/openai-python'],
  anthropic:  ['anthropics/anthropic-sdk-typescript', 'anthropics/anthropic-sdk-python'],
  shopify:    ['Shopify/shopify-api-js'],
  twilio:     ['twilio/twilio-node'],
  sendgrid:   ['sendgrid/sendgrid-nodejs'],
  slack:      ['slackapi/node-slack-sdk'],
  github:     ['octokit/octokit.js'],
  plaid:      ['plaid/plaid-node'],
  cloudflare: ['cloudflare/cloudflare-typescript'],
  supabase:   ['supabase/supabase-js'],
  notion:     ['makenotion/notion-sdk-js'],
  google:     ['googleapis/google-api-nodejs-client'],
  aws:        ['aws/aws-sdk-js-v3'],
  meta:       ['facebook/facebook-nodejs-business-sdk'],
  paypal:     ['paypal/PayPal-TypeScript-Server-SDK'],
  hubspot:    ['HubSpot/hubspot-api-nodejs'],
  salesforce: ['jsforce/jsforce'],
  vercel:     ['vercel/sdk'],
  firebase:   ['firebase/firebase-js-sdk'],
};

// Official developer changelog feeds (RSS 2.0) — API-endpoint-level change sources,
// complementing SDK release feeds above. Verified 200 + parseable before inclusion.
// (salesforce developer blog feed returns 403 to non-browser agents — excluded.)
const CHANGELOG_SOURCES = {
  shopify:    ['https://shopify.dev/changelog/feed.xml'],
  cloudflare: ['https://developers.cloudflare.com/changelog/rss.xml'],
  slack:      ['https://api.slack.com/changelog.rss'],
  github:     ['https://github.blog/changelog/feed/'],
};

// Cap entries taken per changelog feed (some feeds ship years of history, e.g. Cloudflare ~6MB).
const CHANGELOG_MAX_ENTRIES = 30;

// classifier-v3 (Loop 32): split BREAKING into strong signals vs removal/rename words.
// Removal words only count as breaking when the sentence is about the consumer contract,
// not repo/CI/tooling chores ("Remove scheduled release workflow", "Remove unused ... (internal)").
const BREAKING_STRONG_RE = /\b(breaking|drops? support|no longer|incompatible|must (now )?(use|migrate))\b/i;
const BREAKING_REMOVAL_RE = /\b(removed?|renamed)\b/i;
const TOOLING_CONTEXT_RE = /\b(workflow|ci\b|pipeline|github actions?|scheduled release|lint(er|ing)?|eslint|prettier|codecov|codegen|build (script|step|tool)|dev[- ]dependenc|npm script|pnpm|yarn\b|monorepo (setup|conversion)|repo(sitory)? (setup|config|structure)|internal(ly)?(?:[- ](only|used|use))?|unused\b|redundant\b|test (file|helper|fixture)s?)\b/i;
// Note: no trailing \b — "deprecat" is a stem that must match "deprecated"/"deprecation"
// (a trailing \b after the stem can never match a following letter; this bug silently
// disabled the "deprecat" branch in v1/v2 — caught by Loop 32 benchmark on AWS #850).
const DEPRECATION_RE = /\b(deprecat\w*|sunset|end[- ]of[- ]life|eol\b|will be removed)/i;
const ADDITIVE_RE = /\b(add(s|ed)?|new (endpoint|method|param|feature)|support for|introduc|features\b)/i;
const DOCS_RE = /\b(docs?|documentation|readme|typo|changelog)\b/i;
const FIX_RE = /\b(fix(es|ed)?\b|bug ?fix|hotfix|patch(es|ed)? (a|the|an)?\s*(bug|issue|error|crash|regression)|resolve[sd]? (an? )?(bug|issue|error)|regression\b|bump(s|ed)?\b[^.\n]{0,40}(dependenc|deps?\b|version)|chore\(deps\)|dependency (bump|update))/i;

// Fallback: many SDK releases title themselves with just a version string
// (e.g. "@slack/types@3.0.0", "v6.4.0", "8.1.2"). Classify by semver convention:
// major .0.0 => breaking, minor .x.0 => additive, patch => fix. Pre-releases stay unknown.
function classifyByVersion(title) {
  // version at end ("@slack/types@3.0.0", "v6.4.0") or at start ("43.0.0: Merge pull request ...")
  const m = title.match(/(?:^|[@\sv])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\s*$/)
    || title.match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\s*[:\s]/);
  if (!m) return null;
  if (m[4]) return null; // pre-release (rc/canary/beta) — not enough signal
  const [, , minor, patchN] = m;
  if (minor === '0' && patchN === '0') return 'breaking';
  if (patchN === '0') return 'additive';
  return 'fix';
}

// Stainless-generated release notes always end with a boilerplate
// "Full Changelog: vX.Y.Z...vA.B.C" line; the word "changelog" in it is not a
// docs signal and buried real feature releases as docs-only (Loop 31 audit,
// 8/17 misclassifications). Strip it before classifying.
export function stripBoilerplate(text) {
  return text
    .replace(/\*{0,2}full changelog\*{0,2}:?\s*\S*/gi, ' ')
    .replace(/see the changelog for more details\s*\.?/gi, ' ')
    .replace(/compare view:?\s*\S*/gi, ' ');
}

// "Remove X" is only breaking when it touches the consumer contract. Check each
// removal mention's local context (same line/sentence) for CI/tooling vocabulary.
function isContractRemoval(text) {
  const lines = text.split(/[\n.;]/);
  for (const line of lines) {
    if (BREAKING_REMOVAL_RE.test(line) && !TOOLING_CONTEXT_RE.test(line)) return true;
  }
  return false;
}

// Order matters: breaking > deprecation > additive > fix > docs-only.
// "fix" ranks below "additive" so releases that both add and fix count as additive
// (the more consumer-visible change wins). classifier tag: keyword-v3.
export function classify(rawText, title = '') {
  const text = stripBoilerplate(rawText);
  if (BREAKING_STRONG_RE.test(text)) return 'breaking';
  if (isContractRemoval(text)) return 'breaking';
  if (DEPRECATION_RE.test(text)) return 'deprecation';
  if (ADDITIVE_RE.test(text)) return 'additive';
  if (FIX_RE.test(text)) return 'fix';
  if (DOCS_RE.test(text)) return 'docs-only';
  return classifyByVersion(title) || 'unknown';
}

function openDb() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      source_repo TEXT,
      title TEXT NOT NULL,
      change_type TEXT NOT NULL,          -- breaking | deprecation | additive | docs-only | unknown
      classifier TEXT NOT NULL DEFAULT 'keyword-v1',
      effective_date TEXT,                 -- ISO date the change was published
      migration_hint TEXT,
      source_url TEXT NOT NULL UNIQUE,
      raw_excerpt TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_changes_provider ON changes(provider);
    CREATE INDEX IF NOT EXISTS idx_changes_type ON changes(change_type);
  `);
  return db;
}

// Minimal Atom parser — GitHub release feeds are well-formed, entries are flat.
function parseAtom(xml) {
  const entries = [];
  const blocks = xml.split('<entry>').slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    const linkM = b.match(/<link[^>]*href="([^"]+)"/);
    const decode = (s) => s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    entries.push({
      title: decode(pick('title')),
      updated: pick('updated'),
      url: linkM ? linkM[1] : '',
      content: decode(pick('content')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
    });
  }
  return entries;
}

async function fetchFeed(repo) {
  const url = `https://github.com/${repo}/releases.atom`;
  const res = await fetch(url, { headers: { 'user-agent': 'mendapi-watcher/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return parseAtom(await res.text());
}

// Minimal RSS 2.0 parser for official developer changelog feeds.
function parseRss(xml) {
  const entries = [];
  const blocks = xml.split(/<item>/).slice(1);
  const decode = (s) => s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    const pubDate = pick('pubDate');
    let iso = null;
    if (pubDate) {
      const d = new Date(decode(pubDate));
      if (!Number.isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
    }
    entries.push({
      title: decode(pick('title')),
      updated: iso || '',
      url: decode(pick('link')),
      content: decode(pick('description') || pick('content:encoded'))
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
    });
  }
  return entries;
}

async function fetchChangelog(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'mendapi-watcher/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return parseRss(await res.text()).slice(0, CHANGELOG_MAX_ENTRIES);
}

async function main() {
  const db = openDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO changes (provider, source_repo, title, change_type, classifier, effective_date, source_url, raw_excerpt)
    VALUES (?, ?, ?, ?, 'keyword-v3', ?, ?, ?)
  `);
  let inserted = 0, errors = 0;
  const jobs = [];
  for (const [provider, repos] of Object.entries(SOURCES)) {
    for (const repo of repos) {
      jobs.push(
        fetchFeed(repo)
          .then((entries) => {
            for (const e of entries) {
              if (!e.url) continue;
              const type = classify(`${e.title} ${e.content}`, e.title);
              const r = insert.run(provider, repo, e.title, type, e.updated?.slice(0, 10) || null, e.url, e.content);
              inserted += r.changes;
            }
            console.log(`ok    ${provider.padEnd(11)} ${repo} (${entries.length} entries)`);
          })
          .catch((err) => {
            errors++;
            console.error(`error ${provider.padEnd(11)} ${repo}: ${err.message}`);
          })
      );
    }
  }
  await Promise.all(jobs);

  // Changelog feeds (endpoint-level sources). source_repo stores the feed URL so
  // downstream consumers (scanner) can distinguish changelog vs SDK-release changes.
  const clJobs = [];
  for (const [provider, urls] of Object.entries(CHANGELOG_SOURCES)) {
    for (const url of urls) {
      clJobs.push(
        fetchChangelog(url)
          .then((entries) => {
            for (const e of entries) {
              if (!e.url) continue;
              const type = classify(`${e.title} ${e.content}`, e.title);
              const r = insert.run(provider, `changelog:${url}`, e.title, type, e.updated || null, e.url, e.content);
              inserted += r.changes;
            }
            console.log(`ok    ${provider.padEnd(11)} changelog ${url} (${entries.length} entries)`);
          })
          .catch((err) => {
            errors++;
            console.error(`error ${provider.padEnd(11)} changelog ${url}: ${err.message}`);
          })
      );
    }
  }
  await Promise.all(clJobs);
  const total = db.prepare('SELECT COUNT(*) c FROM changes').get().c;
  const providers = db.prepare('SELECT COUNT(DISTINCT provider) c FROM changes').get().c;
  const byType = db.prepare('SELECT change_type, COUNT(*) c FROM changes GROUP BY change_type ORDER BY c DESC').all();
  console.log(`\ninserted=${inserted} errors=${errors} total=${total} providers=${providers}`);
  console.log('by type: ' + byType.map((r) => `${r.change_type}=${r.c}`).join(' '));
  db.close();
  if (errors > 0 && inserted === 0) process.exit(1);
}

// Run only when invoked directly (keeps `classify` importable for tests without side effects).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
