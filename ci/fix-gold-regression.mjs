#!/usr/bin/env node
// Gold-standard regression for the fixer (diff quality baseline).
// Asserts on KNOWN fixture repos that:
//   1. dry-run emits a patch that `git apply` accepts cleanly,
//   2. git-applied result is byte-identical to fixer --apply output,
//   3. applied code passes `node --check` and contains the migrated API surface,
//   4. a second --apply run is a no-op (idempotent),
//   5. already-migrated repos (gold/stripe-app) are left untouched.
// Zero npm dependencies, zero network.
//
// Usage: node ci/fix-gold-regression.mjs
// NOTE: generated from the canonical spec at loop/fix-gold-regression.mjs
// (path-adjusted for the standalone app repo). Do not edit by hand; edit
// the canonical copy and re-sync (verify gate enforces byte parity).
// Exit 0 = all assertions pass; exit 1 = regression.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXER = join(ROOT, 'fixer.js');
const FIXTURES = join(ROOT, 'fixtures');
const work = mkdtempSync(join(tmpdir(), 'fix-gold-'));

let pass = 0, fail = 0;
const failures = [];
function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsFiles(p);
    else if (st.isFile() && /\.(js|mjs|cjs|ts|tsx)$/.test(name)) yield p;
  }
}

function snapshot(dir) {
  const map = {};
  for (const f of jsFiles(dir)) map[relative(dir, f)] = readFileSync(f, 'utf8');
  return map;
}

// Per-fixture gold spec: migration name, strings that MUST appear after the
// fix, and legacy strings that MUST be gone.
const CASES = [
  {
    fixture: 'demo-openai-v3',
    migration: 'openai-v3-to-v4',
    mustHave: [
      'new OpenAI',
      'await openai.chat.completions.create(',
      'await openai.embeddings.create(',
      'response.choices',
      // syntax-aware guard: string/comment/template mentions of the legacy
      // API must survive the fix untouched (naive regex would corrupt them)
      "'if you still call openai.createChatCompletion( upgrade to v4'",
      '`migrating away from .createEmbedding( for tenant`',
      '// Docs note: openai.createChatCompletion({...}) was the v3 entry point.',
    ],
    mustNotHave: [
      'new Configuration',
      'OpenAIApi',
      'await openai.createChatCompletion(',
      'await openai.createEmbedding(',
      'response.data.choices',
      // string/comment must NOT have been rewritten to the new name
      'call openai.chat.completions.create( upgrade',
      'away from .embeddings.create( for tenant',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-stripe-v7',
    migration: 'stripe-v7-to-v8',
    mustHave: ['apiVersion:', 'maxNetworkRetries:'],
    mustNotHave: ['.setApiVersion(', '.setMaxNetworkRetries(', '.setTimeout(', '.setHttpAgent('],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-aws-v2',
    migration: 'aws-sdk-v2-to-v3-s3',
    mustHave: ["require('@aws-sdk/client-s3')", 'new S3Client(', '.send(new GetObjectCommand(', '.send(new PutObjectCommand(', '.send(new ListObjectsV2Command(', '.send(new DeleteObjectCommand(', '.Body.transformToString('],
    mustNotHave: ["require('aws-sdk')", 'new AWS.S3(', '.promise()', '.Body.toString('],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-cf-kv',
    migration: 'cloudflare-kv-legacy-routes',
    mustHave: ['storage/kv/namespaces'],
    mustNotHave: ['workers/namespaces'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-slack-v8',
    migration: 'slack-sdk-v8-errors',
    mustHave: ['instanceof WebAPIPlatformError', 'instanceof WebAPIRateLimitedError', 'instanceof WebAPIRequestError', '!(error instanceof WebAPIHTTPError)', 'instanceof IncomingWebhookHTTPError', 'instanceof IncomingWebhookRequestError'],
    mustNotHave: ['ErrorCode'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-shopify-caapi',
    migration: 'shopify-customer-account-draftorder-price',
    mustHave: ['approximateDiscountedUnitPrice'],
    mustNotHave: ['discountedUnitPrice'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-shopify-checkout',
    migration: 'shopify-customer-last-incomplete-checkout',
    mustHave: ['defaultAddress', 'emailAddress', 'displayName'],
    mustNotHave: ['lastIncompleteCheckout', 'appliedGiftCards'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-shopify-marketing',
    migration: 'shopify-marketing-engagement-cumulative',
    mustHave: ['marketingEngagementCreate', 'occurredOn'],
    mustNotHave: ['isCumulative'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-shopify-fulfillment',
    migration: 'shopify-order-fulfillment-not-required',
    mustHave: ["case 'FULFILLMENT_NOT_REQUIRED':", "case 'UNFULFILLED':", "FULFILLMENT_NOT_REQUIRED: 'Unfulfilled',", "'FULFILLMENT_NOT_REQUIRED': 3,"],
    mustNotHave: [],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-hubspot-v12',
    migration: 'hubspot-blogposts-api-move',
    mustHave: [
      'cms.blogs.basicApi.pushLive', 'cms.blogs.batchApi.create', 'cms.blogs.multiLanguageApi.setLangPrimary',
      // pollution tripwires: astlite must leave legacy names alone inside
      // string literals, template literals, and comments
      "'callers still on cms.blogs.blogPostsApi.pushLive( must upgrade to v13'",
      '`${MIGRATION_HINT}: audit for cms.blogs.blogPostsApi.readBatch( usage per tenant`',
      '// Docs note: cms.blogs.blogPostsApi.getById({...}) was the v12 namespace.',
    ],
    mustNotHave: [
      // real call sites gone (argument-anchored so tripwires are not hit)
      'blogPostsApi.getById(postId', 'blogPostsApi.pushLive(postId', 'blogPostsApi.createBatch({ inputs',
      'blogPostsApi.readBatch({', 'blogPostsApi.setLangPrimary({',
      // tripwires must not be rewritten to the new namespaces
      'callers still on cms.blogs.basicApi.pushLive(',
      'audit for cms.blogs.batchApi.read( usage',
      'Docs note: cms.blogs.basicApi.getById(',
    ],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-twilio-verify',
    migration: 'twilio-verify-attempts-summary-servicesid',
    mustHave: ['VerifyServiceSid=${verifySid}', 'verifyServiceSid: verifySid', '/v2/Services/${serviceSid}/Entities', 'services(serviceSid)'],
    mustNotHave: ['Summary?ServiceSid', '+ `ServiceSid=', 'serviceSid: verifySid'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-twilio-a2p',
    migration: 'twilio-messaging-brand-registration-a2p-casing',
    mustHave: ["form.set('A2PProfileBundleSid'", '&A2PProfileBundleSid=', 'a2PProfileBundleSid: a2pProfileSid', 'brand.a2pProfileBundleSid'],
    mustNotHave: ['A2pProfileBundleSid'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-v0',
    migration: 'paypal-server-sdk-v1-controller-renames',
    mustHave: ['ordersController.createOrder(', 'ordersController.captureOrder(', 'ordersController.createOrderTracking(', 'ordersController.updateOrderTracking(', 'paymentsController.captureAuthorizedPayment(', 'paymentsController.voidPayment(', 'paymentsController.refundCapturedPayment(', 'paymentsController.getRefund(', 'ledger.authorizationsGet(id)', 'ledger.capturesRefund(id)'],
    mustNotHave: ['ordersController.ordersCreate', 'ordersController.ordersGet', 'ordersController.ordersTrackCreate', 'paymentsController.authorizationsGet', 'paymentsController.authorizationsVoid', 'paymentsController.capturesRefund', 'paymentsController.refundsGet'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-paypal-v1',
    migration: 'paypal-server-sdk-v2-options-object',
    mustHave: ['createOrder({ body: orderRequest, paypalRequestId: requestId })', "captureOrder({ id: orderId, prefer: 'return=representation' })", 'getOrder({ id })', 'patchOrder({ id, body: patchBody }, requestOptions)', 'createOrderTracking({ id, body: { carrier: tracker.carrier, trackingNumber: tracker.number } })', 'getAuthorizedPayment({ authorizationId })', "reauthorizePayment({ authorizationId, prefer: 'return=minimal', body: { amount: auth.amount } })", 'voidPayment({ authorizationId: authId })', 'getRefund({ refundId: refund.id })', "dispatcher.getRefund(id, 'ledger')", 'dispatcher.voidPayment(id)', 'getRefund(id, source) { return { id, source }; }'],
    mustNotHave: ['createOrder(orderRequest, undefined, requestId)', 'getOrder(id)', 'voidPayment(authId)', 'getCapturedPayment(captureId)', 'captureAuthorizedPayment(authorizationId, undefined'],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-stripe-v22',
    migration: 'stripe-node-v22-httpclient-interface',
    mustHave: ['class InstrumentedClient implements Stripe.HttpClient {', 'class InstrumentedResponse implements Stripe.HttpClientResponse {', 'class MigratedClient implements Stripe.HttpClient {', 'class TelemetryClient extends Stripe.HttpClient {', 'class TelemetryResponse extends Stripe.HttpClientResponse {}'],
    mustNotHave: ['InstrumentedClient extends', 'InstrumentedResponse extends'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-twilio-linkshortening',
    migration: 'twilio-linkshortening-messagingservicesids-removal',
    mustHave: ["form.set('FallbackUrl'", "fallbackUrl: 'https://example.com/expired'", "messagingServiceSidsAction: 'REPLACE'"],
    mustNotHave: ["form.set('MessagingServiceSids'", "form.append('MessagingServiceSidsAction'", 'MessagingServiceSids:', 'MessagingServiceSidsAction:', "messagingServiceSidsAction: 'ADD'"],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-cloudflare-v6',
    migration: 'cloudflare-typescript-v7-deterministic-renames',
    mustHave: ['.getByIDs(', '.deleteByIDs(', '.getMeetingByID(', 'SchemaHTTP', "import { BaseCloudflare } from 'cloudflare/client';", 'extends BaseCloudflare', "'cloudflare/resources/zones/zones'", 'fs.createReadStream(', "import fs from 'node:fs';", 'inventory.getByIds(localIds)', 'getByIds(ids) {',
      // syntax-aware guard: string/comment/template mentions of the legacy
      // casing must survive the fix untouched (naive regex would corrupt them)
      '// Docs note: client.vectorize.indexes.getByIds({...}) was the v6 casing.',
      "'callers still on .deleteByIds( must upgrade to v7'",
      '`${MIGRATION_HINT}: audit for .getMeetingById( usage per tenant`',
      // identifier-rename tripwires: DEXTest* mentions in string / prose
      // comment / template text must survive; the live JSDoc type reference
      // MUST be rewritten (includeJsdoc)
      '// Prose note: DEXTestGetResponse was removed in v7 (tripwire, keep as-is).',
      "'code importing DEXTestListResponse must move to SchemaHTTPS'",
      '`${TYPE_HINT}: grep for DEXTestGetResponse before release`',
      '.SchemaHTTP>} */',
      // APIClient identifier-rename tripwires: string / prose comment /
      // template mentions of the legacy base-class name must survive; the
      // real import and extends clause MUST be rewritten
      '// Upgrade note: subclasses of APIClient must move to the new base (tripwire, keep as-is).',
      "'custom transports extending APIClient must migrate before v7'",
      '`${UPGRADE_WARNING}: grep for APIClient subclasses in this repo`'],
    mustNotHave: ['.getByIds(indexName', '.deleteByIds(indexName', 'getMeetingById(meetingId', 'DEXTestGetResponse>}', 'import { APIClient }', 'extends APIClient', "cloudflare/src/", 'fileFromPath',
      // tripwires must NOT have been rewritten to the new casing
      'on .deleteByIDs( must upgrade',
      'audit for .getMeetingByID( usage',
      'indexes.getByIDs({...}) was the v6 casing',
      'Prose note: SchemaHTTP was removed',
      'importing SchemaHTTPS must move',
      'grep for SchemaHTTP before release',
      // APIClient tripwires must NOT have been rewritten to the new name
      'subclasses of BaseCloudflare must move to the new base',
      'extending BaseCloudflare must migrate',
      'grep for BaseCloudflare subclasses'],
    minFilesChanged: 3,
  },
  {
    fixture: 'demo-cloudflare-v7params',
    migration: 'cloudflare-typescript-v7-named-path-params',
    mustHave: ['values.get(key, { namespace_id: nsId, account_id: ACCOUNT })', 'values.delete(key, { namespace_id: nsId })', 'certificates.update(certId, { custom_hostname_id: hostId, certificate_pack_id: packId, account_id: ACCOUNT, validity_days: 90 })', "history(logId, { organization_id: orgId, since: '2026-01-01' }, { maxRetries: 2 })", 'values.get(key, { namespace_id: nsId, account_id: ACCOUNT });\n}\n\nconst ACCOUNT', 'registry.namespaces.values.get(nsId, key)', 'registry.namespaces.values.delete(nsId, key)'],
    mustNotHave: ['client.kv.namespaces.values.get(nsId', 'client.kv.namespaces.values.delete(nsId', 'update(hostId, packId, certId', 'history(orgId, logId'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-plaid-v42',
    migration: 'plaid-node-v43-v44-breaking-renames',
    mustHave: ['ProductsTerminateReasonCode.UserClosedAccount', "reports_requested: ['VOE']", "=== 'interest only'", "case 'interest only':", "'interest-only': { termYears: 10", 'Payments cover interest only until'],
    mustNotHave: ['ItemProductsTerminateReasonCode', 'UserProductsTerminateReasonCode', 'report_requested:', "type === 'interest-only'", "case 'interest-only':"],
    minFilesChanged: 2,
  },
  {
    fixture: 'demo-vercel-analytics',
    migration: 'vercel-web-analytics-dhe-cipher-suite-removal',
    mustHave: ["DIMENSIONS = ['browser', 'country']", 'const { browser } = row;', 'stats[browser]', 'country: row.country,', 'totalVisits += entry.visits;', "dheCipherSuite: 'DHE-RSA-AES256-GCM-SHA384'", 'seen.add(record.dheCipherSuite);',
      // AST-track pass: dead multi-line binding in share.js collapses to the
      // surviving visits binding; the consumer line is untouched
      'const { visits } = rows[0];',
      'return visits;',
      // guard: alias-form pattern whose binding is referenced afterwards
      // survives untouched (export.js) — this is exactly the shape the old
      // line-level rule used to delete whole-line, mangling live siblings
      'const { dheCipherSuite: suite, country } = row;',
      'return { suite, country };'],
    mustNotHave: ["'dheCipherSuite',", '{ dheCipherSuite, browser }', 'stats[dheCipherSuite]', 'dheCipherSuite: row.dheCipherSuite', 'totalByCipher[entry.dheCipherSuite]',
      // multi-line pattern residue: the dead entry line must be gone
      'const {\n    dheCipherSuite,\n    visits,\n  } = rows[0];'],
    minFilesChanged: 3,
  },
  {
    fixture: 'demo-vercel-extmaxdur',
    migration: 'vercel-project-extended-max-duration-removal',
    mustHave: ["resourceConfig: { functionDefaultMemoryType: 'standard' }", 'resourceConfig: {},', 'const { functionDefaultMemoryType } = project.resourceConfig;', 'memory: functionDefaultMemoryType,', "'project-created',", "'project-removed',", 'summary.renamed += 1;', "enableFunctionsExtendedMaxDuration: true,\n  queue: 'default',", 'if (config.enableFunctionsExtendedMaxDuration) {',
      // AST-track pass: dead multi-line binding in limits.js collapses to the
      // surviving sibling; the consumer line is untouched
      'const { functionDefaultMemoryType } = proj.resourceConfig;',
      'return `memory tier: ${functionDefaultMemoryType}`;',
      // reference-count guard: the aliased binding in mirror.js is still
      // live, so the whole pattern survives untouched
      'const { enableFunctionsExtendedMaxDuration: ext, functionDefaultMemoryType } = project.resourceConfig;',
      'return { extended: ext === true, memory: functionDefaultMemoryType };',
      // anchor-gate guard: the unanchored flat pattern in tuning.js keeps
      // the whole file byte-identical even though the binding is dead
      'const { enableFunctionsExtendedMaxDuration, cpu } = row;'],
    mustNotHave: ['project-functions-extended-max-duration-updated', 'extendedDuration:', 'durationToggles += 1', 'payload.enableFunctionsExtendedMaxDuration', '{ enableFunctionsExtendedMaxDuration, functionDefaultMemoryType }',
      'enableFunctionsExtendedMaxDuration,\n    functionDefaultMemoryType'],
    minFilesChanged: 3,
  },
  {
    fixture: 'demo-stripe-settlement',
    migration: 'stripe-us-bank-preferred-settlement-speed-removal',
    mustHave: ["us_bank_account: { verification_method: 'automatic' }", 'const { verification_method } = opts;', 'verification: verification_method,', "preferred_settlement_speed: 'standard',", "if (config.preferred_settlement_speed === 'fastest') {"],
    mustNotHave: ["preferred_settlement_speed: 'fastest'", '{ preferred_settlement_speed, verification_method }', "fast: preferred_settlement_speed === 'fastest'"],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-stripe-tipping',
    migration: 'stripe-terminal-tipping-bgn-removal',
    mustHave: ["eur: { percentages: [5, 10, 15], smart_tip_threshold: 5 },", 'const { eur } = cfg.tipping;', 'euroPresets: eur ? eur.percentages : [],', 'bgn: 0.5113,', 'const rate = FX_RATES[currency];',
      // AST-track pass: dead multi-line bgn binding collapses to the
      // surviving sibling; the consumer line is untouched
      'const { usd } = cfg.tipping;',
      'return usd.fixed_amounts.length;',
      // anchor-gate guard: an unanchored flat pattern in presets.js keeps
      // the whole file byte-identical even though bgn is a dead binding
      'const { bgn, eur } = roundingPresets;',
      'const roundingPresets = { bgn: 2, eur: 2, usd: 2 };'],
    mustNotHave: ['bgn: { percentages', '{ bgn, eur } = cfg.tipping', 'cfg.tipping.bgn', 'hasLev',
      'bgn,\n    usd'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-vercel-publicsource',
    migration: 'vercel-project-public-source-removal',
    mustHave: ["framework: 'nextjs',", 'const { name, framework } = project;', "return projects.map((p) => ({ name: p.name}));", 'source visible: ${event.payload.publicSource}', 'if (event.payload.publicSource === true) publicCount += 1;', 'publicSource: true,\n  outputDir: \'dist\',', 'if (config.publicSource) {'],
    mustNotHave: ['publicSource: true,\n    framework', '{ publicSource, name, framework }', 'sourceVisible:', "summary.badge = 'public'", 'publicSource: p.publicSource'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-vercel-storeskills',
    migration: 'vercel-store-agent-skill-url-to-agent-skills',
    mustHave: ['const skillUrl = store.product.agentSkills?.[0];', "store?.product?.agentSkills?.[0] ?? 'no guide published'", "agentSkillUrl: 'https://docs.internal/starter-guide'", 'return item ? item.agentSkillUrl : null;'],
    mustNotHave: ['store.product.agentSkillUrl', 'product?.agentSkillUrl'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-vercel-vcr',
    migration: 'vercel-vcr-image-id-or-digest-rename',
    mustHave: ['getRepositoryImage({ idOrName: repo, imageIdOrDigest: imageId, teamId })', 'imageIdOrDigest: id,', 'deleteRepositoryImage({ idOrName: repo, imageId })', 'async function inspectImage(repo, imageId, teamId) {'],
    mustNotHave: ['getRepositoryImage({ idOrName: repo, imageId,', 'imageId: id,'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-vercel-edgeconfig',
    migration: 'vercel-integration-resource-edge-config-read-move',
    mustHave: ['const resourceList = await fetchJson(`/v1/installations/${icId}/resources`, { headers });', '(resourceList.resources || []).find((r) => r.partnerId === resourceId)', 'edgeConfigSyncingEnabled;', 'edgeConfigTokenId;', 'resource = await fetchJson(`/v1/installations/${icId}/resources/${resourceId}`, { headers });\n  return { plan: resource.billingPlanId'],
    mustNotHave: ['resources/${resourceId}`, { headers });\n  const syncing'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-cloudflare-roles',
    migration: 'cloudflare-account-roles-to-permission-groups',
    mustHave: ['/accounts/${acct}/iam/permission_groups`', '/accounts/${acct}/iam/permission_groups/${roleId}`', "r.meta.label === 'Administrator'", "r.meta.label.startsWith('Audit')", "note.description : 'no note'", "r.description === 'Manager'", '/accounts/${accountId}/roles`'],
    mustNotHave: ["r.description === 'Administrator'", "r.description.startsWith("],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-stripe-cardmeta',
    migration: 'stripe-payment-record-card-details-removal',
    mustHave: ['brand: rec.payment_method_details.card.brand,', "const recurring = rec.payment_method_details.card.stored_credential_usage === 'recurring';", 'network: r.payment_method_details.card.network,', 'label: present.description,', 'bank: present.issuer,', "description: 'Front-desk reader',", "issuer: 'internal-ops',",
      // AST-track pass: dead issuer binding removed, live sibling kept
      'const { brand } = rec.payment_method_details.card;',
      'return brand;',
      // guard: referenced destructuring pattern survives untouched
      'const { description, network } = rec.payment_method_details.card;',
      'return { description, network };'],
    mustNotHave: ['bank: rec.payment_method_details.card.issuer', 'label: rec.payment_method_details.card.description', 'binPrefix: rec.payment_method_details.card.iin', 'firstSix: r.payment_method_details.card.iin', 'console.log(rec.payment_method_details.card.stored_credential_usage)',
      'const { issuer, brand }'],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-stripe-cardiin',
    migration: 'stripe-legacy-card-iin-removal',
    mustHave: [
      'brand: card.brand,',
      'last4: card.last4,',
      'funding: c.funding,',
      'expiry: `${c.exp_month}/${c.exp_year}`,',
      'return source.brand;',
      // AST-track pass: a dead destructured binding loses only the
      // withdrawn field, siblings survive
      'const { funding } = customer.default_source;',
      'return funding;',
      // guards: referenced destructuring and binding declarations survive
      'const { iin, brand } = customer.default_source;',
      'return { iin, brand };',
      'const binPrefix = customer.default_source.iin;',
      // guard: non-Stripe file with an unrelated .iin member is untouched
      'return registry.find(record.card.iin) || null;',
      // guard: comment mentions survive
      '// Comment mentions survive: card.iin was the BIN read before v2349.',
    ],
    mustNotHave: [
      'bin: card.iin',
      'if (card.iin) profile.binKnown = true;',
      'firstSix: c.iin',
      'console.log(source.iin)',
      'const { iin, funding }',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-stripe-boleto',
    migration: 'stripe-payment-record-boleto-tax-id-null-guard',
    mustHave: [
      'const taxId = rec.payment_method_details.boleto.tax_id?.trim();',
      "const compact = rec.payment_method_details.boleto.tax_id?.replace(/\\D/g, '');",
      'doc: r.payment_method_details.boleto.tax_id?.slice(0, 4),',
      'if (rec.payment_method_details.boleto.tax_id === null) return false;',
      'const raw = rec.payment_method_details.boleto.tax_id;',
      'return charge.payment_method_details.boleto.tax_id.trim();',
      'format: (p) => p.tax_id.toUpperCase(),',
    ],
    mustNotHave: [
      'boleto.tax_id.trim()?',
      'const taxId = rec.payment_method_details.boleto.tax_id.trim();',
      'doc: r.payment_method_details.boleto.tax_id.slice(0, 4),',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-swishpix',
    migration: 'paypal-orders-v2-swish-pix-payment-source-removal',
    mustHave: [
      "payment_source: { paypal: { experience_context: { locale: 'sv-SE' } } },",
      'payment_source: {},',
      'const { card } = order.payment_source;',
      "pix: { density: 2, format: 'png' },",
      "swish: { duration: 300, easing: 'ease-out' },",
      'brand: source.card.brand',
      'email: source.paypal.email_address',
      // AST-track pass: the dead multi-line swish binding collapses to the
      // surviving status_details; the consumer line is untouched
      'const { status_details } = order.payment_source;',
      'return { status: order.status, detail: status_details };',
      // referenced negative site: pix is anchored to payment_source but the
      // identifier is referenced — the pattern survives untouched
      'return { pix, card };',
      // anchor-gate negative site: pos.js binds a dead pix off an in-house
      // printer profile row — the unanchored pattern keeps the file intact
      'const { pix, dpi } = printerProfiles.receipt;',
    ],
    mustNotHave: [
      "swish: { name, country_code: 'SE' }",
      "pix: { country_code: 'BR', email_address: email }",
      'payment_source.swish',
      'payment_source.pix',
      // AST-track pass: no multi-line swish binding may survive
      'swish,\n    status_details',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-vaultprofile',
    migration: 'paypal-vault-v3-wallet-profile-fields-removal',
    mustHave: [
      'first: src.paypal.name.given_name,',
      'last: src.paypal.name.surname,',
      'city: src.paypal.address.admin_area_2,',
      'country: t.payment_source.venmo?.address?.country_code,',
      'born: employee.profile.birth_date,',
      'full: employee.profile.name.full_name,',
      'district: employee.profile.address.admin_area_3,',
      // AST-track pass: dead multi-line full_name binding collapses to the
      // surviving given_name; the consumer line is untouched
      'const { given_name } = token.payment_source.paypal.name;',
      'return given_name;',
      // guard: referenced destructuring pattern survives untouched
      'const { birth_date, email_address } = token.payment_source.paypal;',
      'return { birth_date, email_address };',
      // anchor-gate guard: unanchored flat patterns in roster.js keep the
      // whole file byte-identical even though the bindings are dead
      'const { full_name, team } = row;',
      'const { birth_date, badge } = row;',
    ],
    mustNotHave: [
      'src.paypal.name.full_name',
      'src.paypal.birth_date',
      'src.paypal.address.admin_area_3',
      'src.paypal.tax_info',
      'venmo?.name?.alternate_full_name',
      'venmo?.birth_date',
      'full_name,\n    given_name',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-applepaycard',
    migration: 'paypal-vault-v3-apple-pay-card-fields-removal',
    mustHave: [
      'holder: src.apple_pay.card.name,',
      'tail: src.apple_pay.card.last_digits,',
      'network: src.apple_pay.card.brand,',
      'type: t.payment_source.apple_pay?.card?.type,',
      'pan: wallet.apple_pay.card.number,',
      'kind: wallet.apple_pay.card.card_type,',
      'ref: wallet.apple_pay?.card?.id,',
      // AST-track pass: dead multi-line expiry binding collapses to the
      // surviving sibling; the consumer line is untouched
      'const { last_digits } = token.payment_source.apple_pay.card;',
      'return last_digits;',
      // guard: referenced destructuring pattern survives untouched
      'const { card_type, brand } = token.payment_source.apple_pay.card;',
      'return { card_type, brand };',
      // anchor-gate guard: an unanchored flat pattern in registry.js keeps
      // the whole file byte-identical even though id is a dead binding
      'const { id, label } = row;',
      'return label;',
    ],
    mustNotHave: [
      'src.apple_pay.card.number',
      'src.apple_pay.card.expiry',
      'src.apple_pay.card.card_type',
      'src.apple_pay.card.security_code',
      'src.apple_pay?.card?.id',
      'apple_pay?.card?.expiry',
      'expiry,\n    last_digits',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-ilink',
    migration: 'paypal-vault-v3-information-link-error-field-removal',
    mustHave: [
      'code: err.name,',
      'msg: err.message,',
      'trace: err.debug_id,',
      'issues: body.details,',
      'links: body.links,',
      'docs: entry.information_link,',
      'if (entry.information_link) return true;',
      // AST-track pass: the dead multi-line information_link binding
      // collapses to the surviving debug_id; the consumer line is untouched
      'const { debug_id } = err;',
      'return debug_id;',
      // guard: referenced destructuring pattern survives untouched (audit.js)
      'const { information_link, debug_id } = err;',
      'return { information_link, debug_id, at: Date.now() };',
    ],
    mustNotHave: [
      'err.information_link',
      'body?.information_link',
      'console.log(err.information_link)',
      'information_link,\n    debug_id',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-subaddr',
    migration: 'paypal-billing-subscriptions-v1-subscriber-address-removal',
    mustHave: [
      'email: sub.subscriber.email_address,',
      'shipCity: sub.subscriber.shipping_address.address.admin_area_2,',
      'shipCountry: sub.subscriber.shipping_address.address.country_code,',
      'line1: subscriber.address.address_line_1,',
      'zip: subscriber.address.postal_code,',
      'return record.subscriber.address.admin_area_1;',
      // AST-track pass: dead multi-line address binding collapses to the
      // surviving email_address; the consumer line is untouched
      'const { email_address } = sub.subscriber;',
      'return email_address;',
      // guard: referenced destructuring pattern survives untouched
      'const { address, email_address } = sub.subscriber;',
      'return { address, email_address };',
      // anchor-gate guard: the shipping_address chain is deeper than
      // .subscriber, so even a dead address binding stays untouched
      'const { address, name } = sub.subscriber.shipping_address;',
    ],
    mustNotHave: [
      'sub.subscriber.address.address_line_1',
      'sub.subscriber.address.admin_area_2',
      'address_details.street_name',
      'if (sub.subscriber.address)',
      'sub.subscriber?.address?.postal_code',
      'address,\n    email_address',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-shipaddr',
    migration: 'paypal-billing-subscriptions-v1-shipping-address-trim',
    mustHave: [
      'recipient: sub.subscriber.shipping_address.name.full_name,',
      'city: sub.subscriber.shipping_address.address.admin_area_2,',
      'zip: sub.subscriber.shipping_address.address.postal_code,',
      'country: sub.subscriber.shipping_address.address.country_code,',
      'honorific: order.shipping_address.name.prefix,',
      'district: order.shipping_address.address.admin_area_3,',
      'street: order.shipping_address.address.address_details.street_name,',
      // AST-track pass: dead multi-line prefix binding collapses to the
      // surviving full_name; the consumer line is untouched
      'const { full_name } = sub.subscriber.shipping_address.name;',
      'return full_name;',
      // guard: referenced destructuring pattern survives untouched even
      // though address_details is a withdrawn token
      'const { address_details, postal_code } = sub.subscriber.shipping_address.address;',
      'return { address_details, postal_code };',
      // anchor-gate guard: prefix bound off the SURVIVING subscriber.name
      // chain must never be removed even though the binding is dead
      'const { prefix, given_name } = sub.subscriber.name;',
    ],
    mustNotHave: [
      'sub.subscriber.shipping_address.name.prefix',
      'sub.subscriber.shipping_address.name.given_name',
      'sub.subscriber.shipping_address.address.address_line_3',
      'sub.subscriber.shipping_address.address.admin_area_3',
      'sub.subscriber.shipping_address.address.address_details',
      'shipping_address?.name?.alternate_full_name',
      'prefix,\n    full_name',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-pii',
    migration: 'paypal-billing-subscriptions-v1-subscriber-pii-removal',
    mustHave: [
      'email: sub.subscriber.email_address,',
      'surname: sub.subscriber.name.surname,',
      'dob: subscriber.birth_date,',
      'taxId: subscriber.tax_info.tax_id,',
      'taxIdType: subscriber.tax_info.tax_id_type,',
      // AST-track pass: dead multi-line birth_date binding collapses to the
      // surviving email_address; the consumer line is untouched
      'const { email_address } = sub.subscriber;',
      'return email_address;',
      // guard: referenced destructuring pattern survives untouched
      'const { tax_info, email_address } = sub.subscriber;',
      'return { tax_info, email_address };',
      // anchor-gate guard: unanchored flat patterns in payroll.js keep the
      // whole file byte-identical even though the bindings are dead
      'const { birth_date, badge } = row;',
      'const { tax_id, desk } = row;',
    ],
    mustNotHave: [
      'sub.subscriber.birth_date',
      'sub.subscriber.tax_info.tax_id',
      'if (sub.subscriber.tax_info)',
      'sub.subscriber?.birth_date',
      'birth_date,\n    email_address',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-officebearers',
    migration: 'paypal-partner-referrals-v2-office-bearers-removal',
    mustHave: [
      'owners: data.referral_data.business_entity.beneficial_owners,',
      'beneficial_owners: owners,',
      'bearers: company.business_entity.office_bearers,',
      'chair: company.business_entity.office_bearers[0],',
      // AST-track pass: dead multi-line office_bearers binding collapses to
      // the surviving beneficial_owners; the consumer line is untouched
      'const { beneficial_owners } = data.referral_data.business_entity;',
      'return beneficial_owners.map((o) => o.names);',
      // guard: referenced destructuring pattern survives untouched
      'const { office_bearers, names } = data.referral_data.business_entity;',
      'return { office_bearers, names };',
      // anchor-gate guard: unanchored flat pattern in civic.js keeps the
      // whole file byte-identical even though the binding is dead
      'const { office_bearers, seat } = row;',
    ],
    mustNotHave: [
      'office_bearers: officers.map(toBearer),',
      'firstBearerRole: data.referral_data.business_entity.office_bearers[0].role',
      'if (data.referral_data.business_entity.office_bearers)',
      'business_entity?.office_bearers',
      'office_bearers,\n    beneficial_owners',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-contactdetail',
    migration: 'paypal-partner-referrals-v2-contact-detail-trim',
    mustHave: [
      'national_number: owner.phone,',
      "type: 'MOBILE',",
      'ownerPhone: data.referral_data.individual_owners[0].phones[0].national_number,',
      'bizCity: data.referral_data.business_entity.addresses[0].admin_area_2,',
      'bizCountry: data.referral_data.business_entity.addresses[0].country_code,',
      'label: hit.contact_name,',
      'isPrimary: record.phones[0].primary,',
      'return record.addresses.filter((a) => !record.addresses[0].inactive && a.primary);',
      // AST-track pass: dead multi-line contact_name binding collapses to the
      // surviving national_number; the consumer line is untouched
      'const { national_number } = data.referral_data.individual_owners[0].phones[0];',
      'return national_number;',
      // guard: referenced destructuring pattern in directory.js survives
      // untouched (anchored chain, but the binding is used)
      'const { tags, national_number } = data.referral_data.business_entity.phones[0];',
      'return { tags, national_number };',
      // anchor-gate guard: unanchored flat pattern in seating.js keeps the
      // whole file byte-identical even though the binding is dead
      'const { primary, desk } = row;',
    ],
    mustNotHave: [
      'contact_name: owner.displayName,',
      'primary_mobile: true,',
      'ownerContact: data.referral_data.individual_owners[0].phones[0].contact_name',
      'bizPrimaryAddr: data.referral_data.business_entity.addresses[0].primary',
      'if (data.referral_data.individual_owners[0].addresses[0].inactive)',
      'phones?.[0]?.tags',
      'contact_name,\n    national_number',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-errlink',
    migration: 'paypal-invoicing-v2-error-link-method-enum-shrink',
    mustHave: [
      "const retry = err.links.find((l) => l.method === 'POST');",
      "if (link.method === 'HEAD') continue;",
      "if (link.method === 'OPTIONS') continue;",
      "if (req.method === 'CONNECT') return res.end('tunnel unsupported');",
      "if (req.method === 'HEAD' || req.method === 'OPTIONS') return res.end();",
    ],
    mustNotHave: [
      "errLink.method === 'CONNECT'",
      "errLink.method === 'HEAD'",
      "err.links[0].method === 'OPTIONS'",
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-paypal-send202',
    migration: 'paypal-invoicing-v2-send-202-body-unwrap',
    mustHave: [
      'const statusUrl = res.href;',
      'const relName = res.rel;',
      "console.log('poll via', res.method, statusUrl, relName);",
      'return outcome?.href;',
      'const first = invoice.links[0].href;',
      'const primary = job.links[0].href;',
      'const verb = job.links[0]?.method;',
    ],
    mustNotHave: [
      'res.links[0].href',
      'res.links?.[0].rel',
      'res.links[0]?.method',
      'outcome?.links[0].href',
    ],
    minFilesChanged: 1,
  },
  {
    fixture: 'demo-slack-cli',
    migration: 'slack-cli-hooks-file-move',
    mustHave: ["readFileSync('.slack/hooks.json', 'utf8')", "existsSync('.slack/hooks.json')", "'backups/team-slack.json'", "'backups/workspace-slack.json.bak'"],
    mustNotHave: ["'slack.json'", "'./slack.json'"],
    minFilesChanged: 2,
    moved: [{ from: 'slack.json', to: '.slack/hooks.json' }],
  },
];

for (const c of CASES) {
  const src = join(FIXTURES, c.fixture);

  // --- 1. dry-run patch must be git-apply clean ---
  const dryRepo = join(work, `${c.fixture}-dry`);
  cpSync(src, dryRepo, { recursive: true });
  run('git', ['init', '-q'], { cwd: dryRepo });
  const dryOut = join(work, `${c.fixture}-dry-out`);
  const dry = run('node', [FIXER, '--repo', dryRepo, '--migration', c.migration, '--out-dir', dryOut]);
  assert(`${c.fixture} dry-run exits 0`, dry.code === 0, dry.stdout.slice(-200));
  const patch = readFileSync(join(dryOut, 'changes.patch'), 'utf8');
  assert(`${c.fixture} dry-run emits non-empty patch`, patch.length > 0);
  const applyCheck = run('git', ['apply', '--check', join(dryOut, 'changes.patch')], { cwd: dryRepo });
  assert(`${c.fixture} patch is git-apply clean`, applyCheck.code === 0, applyCheck.stdout);
  const gitApply = run('git', ['apply', join(dryOut, 'changes.patch')], { cwd: dryRepo });
  assert(`${c.fixture} patch applies via git`, gitApply.code === 0, gitApply.stdout);

  // --- 2. fixer --apply on a second copy; result must equal git-applied copy ---
  const applyRepo = join(work, `${c.fixture}-apply`);
  cpSync(src, applyRepo, { recursive: true });
  const applyOut = join(work, `${c.fixture}-apply-out`);
  const ap = run('node', [FIXER, '--repo', applyRepo, '--migration', c.migration, '--apply', '--out-dir', applyOut]);
  assert(`${c.fixture} --apply exits 0`, ap.code === 0, ap.stdout.slice(-200));
  const report = JSON.parse(readFileSync(join(applyOut, 'fix-report.json'), 'utf8'));
  assert(`${c.fixture} changed >= ${c.minFilesChanged} file(s)`, report.files.length >= c.minFilesChanged, String(report.files.length));

  // --- evidence chain: report carries in-band syntax verdicts, none failed ---
  const sc = report.verification && report.verification.syntax_check;
  assert(`${c.fixture} report carries verification.syntax_check summary`, !!sc && typeof sc.passed === 'number');
  assert(`${c.fixture} report syntax_check failed=0`, !!sc && sc.failed === 0, sc ? `failed=${sc.failed}` : 'missing');
  const rewrittenFiles = report.files.filter((f) => !f.moved_to);
  assert(`${c.fixture} every rewritten file has a per-file syntax verdict`, rewrittenFiles.every((f) => f.syntax_check && ['pass', 'skipped'].includes(f.syntax_check.status)));
  // repo_checks layer: without --run-checks it must be honestly skipped with a reason (never fabricated)
  const rc = report.verification && report.verification.repo_checks;
  assert(`${c.fixture} report carries verification.repo_checks`, !!rc && typeof rc.status === 'string');
  assert(`${c.fixture} repo_checks skipped by default with reason`, !!rc && rc.status === 'skipped' && /run-checks/.test(rc.reason || ''), rc && rc.status);

  const fromGit = snapshot(dryRepo);
  const fromApply = snapshot(applyRepo);
  const sameKeys = JSON.stringify(Object.keys(fromGit).sort()) === JSON.stringify(Object.keys(fromApply).sort());
  const identical = sameKeys && Object.keys(fromGit).every((k) => fromGit[k] === fromApply[k]);
  assert(`${c.fixture} git-apply result identical to --apply result`, identical);

  // --- 3. applied code: syntax + migrated surface present, legacy gone ---
  let syntaxOk = true;
  for (const f of jsFiles(applyRepo)) if (/\.(js|mjs|cjs)$/.test(f) && run('node', ['--check', f]).code !== 0) syntaxOk = false;
  assert(`${c.fixture} applied code passes node --check`, syntaxOk);
  const blob = Object.values(fromApply).join('\n');
  for (const s of c.mustHave) assert(`${c.fixture} applied code contains "${s}"`, blob.includes(s));
  for (const s of c.mustNotHave) assert(`${c.fixture} applied code free of legacy "${s}"`, !blob.includes(s));

  // --- 4. idempotency: second --apply run must change nothing ---
  const secondOut = join(work, `${c.fixture}-second-out`);
  const second = run('node', [FIXER, '--repo', applyRepo, '--migration', c.migration, '--apply', '--out-dir', secondOut]);
  assert(`${c.fixture} second --apply is no-op (exit 1)`, second.code === 1, `exit=${second.code}`);
  const secondReport = JSON.parse(readFileSync(join(secondOut, 'fix-report.json'), 'utf8'));
  assert(`${c.fixture} second --apply changed 0 files`, secondReport.files.length === 0, String(secondReport.files.length));

  // --- 5. file moves (repo-level transforms): both the git-applied copy and
  // the --apply copy must have the file at the new path, byte-identical to
  // the fixture source, with the old path gone ---
  for (const mv of c.moved || []) {
    const srcContent = readFileSync(join(src, mv.from), 'utf8');
    for (const [label, repo] of [['git-apply', dryRepo], ['--apply', applyRepo]]) {
      let movedOk = false;
      try {
        movedOk = readFileSync(join(repo, mv.to), 'utf8') === srcContent;
      } catch { movedOk = false; }
      assert(`${c.fixture} ${label}: ${mv.to} exists with identical content`, movedOk);
      let oldGone = true;
      try { readFileSync(join(repo, mv.from)); oldGone = false; } catch { oldGone = true; }
      assert(`${c.fixture} ${label}: legacy ${mv.from} removed`, oldGone);
    }
  }
}

// --- 5. negative control: gold/stripe-app is already migrated; fixer must not touch it ---
{
  const src = join(FIXTURES, 'gold', 'stripe-app');
  const repo = join(work, 'gold-stripe-app');
  cpSync(src, repo, { recursive: true });
  const before = snapshot(repo);
  const out = join(work, 'gold-stripe-app-out');
  const r = run('node', [FIXER, '--repo', repo, '--migration', 'stripe-v7-to-v8', '--apply', '--out-dir', out]);
  assert('gold/stripe-app fixer reports nothing to change (exit 1)', r.code === 1, `exit=${r.code}`);
  const after = snapshot(repo);
  const untouched = Object.keys(before).every((k) => before[k] === after[k]);
  assert('gold/stripe-app files untouched', untouched);
}

// --- 6. repo_checks positive path: with --run-checks the fixture's own test
// script must run against the rewritten files and pass ---
{
  const src = join(FIXTURES, 'demo-openai-v3');
  const repo = join(work, 'repo-checks-openai');
  cpSync(src, repo, { recursive: true });
  const out = join(work, 'repo-checks-openai-out');
  const r = run('node', [FIXER, '--repo', repo, '--migration', 'openai-v3-to-v4', '--apply', '--run-checks', '--out-dir', out]);
  assert('repo-checks: --apply --run-checks exits 0', r.code === 0, `exit=${r.code}`);
  const report = JSON.parse(readFileSync(join(out, 'fix-report.json'), 'utf8'));
  const rc = report.verification && report.verification.repo_checks;
  assert('repo-checks: status=ran', !!rc && rc.status === 'ran', rc && rc.status);
  assert('repo-checks: failed=0 and passed>=1', !!rc && rc.failed === 0 && rc.passed >= 1, rc && `passed=${rc.passed} failed=${rc.failed}`);
  assert('repo-checks: per-script entry cites test script with exit_code 0', !!rc && rc.checks.some((c) => c.script === 'test' && c.status === 'pass' && c.exit_code === 0));
}

rmSync(work, { recursive: true, force: true });
console.log(`\nFIX GOLD RESULT: PASS=${pass} FAIL=${fail}${fail ? ' — ' + failures.join(' | ') : ''}`);
process.exit(fail ? 1 : 0);
