#!/usr/bin/env node
// mendapi fixer — applies migration rules for known upstream API breaking
// changes and emits a reviewable patch (unified diff) plus a fix report.
// Zero npm dependencies: node:fs + node:child_process (git for diffing).
//
// Usage:
//   node app/fixer.js --repo /path/to/repo --migration openai-v3-to-v4 [--apply] [--out-dir dir]
//   node app/fixer.js --from-report /path/to/impact-report.json [--repo path] [--apply] [--out-dir dir]
//
// --from-report wires the fixer to the scanner: it reads a scanner impact
// report, matches detected providers against available migration packs, and
// runs every applicable migration. The repo path defaults to the one recorded
// in the report.
//
// Without --apply the fixer runs in dry-run mode: it writes the patch and the
// report but leaves the repo untouched. With --apply it rewrites the files.
//
// Design: migrations are deterministic rule packs (regex/AST-lite transforms)
// derived from official SDK migration guides. An LLM layer can be added later
// for long-tail changes; the deterministic core stays the source of truth.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPackFreshness } from './revalidate.js';
import { renameCall, renameIdentifier, removeDestructuredProperty, replaceCalls } from './astlite.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'vendor', 'data']);

// ---------- migration rule packs ----------
// Each rule: { desc, detect: RegExp, apply(text) -> text }
// cloudflare-typescript v7.0.0 official migration table: method chain ->
// moved path-param keys (all old path params except the last). Extracted
// mechanically from bin/migration-config.json in the v7.0.0 tag (see the
// cloudflare-typescript-v7-named-path-params pack below). Hoisted to module
// level so the pack can expose its covered SDK chains as metadata.
const CF_V7_MOVED = {
  'addressing.addressMaps.ips.delete': ['address_map_id'],
  'addressing.addressMaps.ips.update': ['address_map_id'],
  'addressing.prefixes.bgpPrefixes.edit': ['prefix_id'],
  'addressing.prefixes.bgpPrefixes.get': ['prefix_id'],
  'addressing.prefixes.delegations.delete': ['prefix_id'],
  'addressing.prefixes.serviceBindings.delete': ['prefix_id'],
  'addressing.prefixes.serviceBindings.get': ['prefix_id'],
  'aiGateway.datasets.delete': ['gateway_id'],
  'aiGateway.datasets.get': ['gateway_id'],
  'aiGateway.datasets.update': ['gateway_id'],
  'aiGateway.dynamicRouting.createDeployment': ['gateway_id'],
  'aiGateway.dynamicRouting.createVersion': ['gateway_id'],
  'aiGateway.dynamicRouting.delete': ['gateway_id'],
  'aiGateway.dynamicRouting.get': ['gateway_id'],
  'aiGateway.dynamicRouting.getVersion': ['gateway_id', 'id'],
  'aiGateway.dynamicRouting.listDeployments': ['gateway_id'],
  'aiGateway.dynamicRouting.listVersions': ['gateway_id'],
  'aiGateway.dynamicRouting.update': ['gateway_id'],
  'aiGateway.evaluations.delete': ['gateway_id'],
  'aiGateway.evaluations.get': ['gateway_id'],
  'aiGateway.logs.edit': ['gateway_id'],
  'aiGateway.logs.get': ['gateway_id'],
  'aiGateway.logs.request': ['gateway_id'],
  'aiGateway.logs.response': ['gateway_id'],
  'aiGateway.urls.get': ['gateway_id'],
  'aiSearch.instances.jobs.get': ['id'],
  'aiSearch.instances.jobs.logs': ['id'],
  'aiSearch.namespaces.instances.chatCompletions': ['name'],
  'aiSearch.namespaces.instances.delete': ['name'],
  'aiSearch.namespaces.instances.items.chunks': ['name', 'id'],
  'aiSearch.namespaces.instances.items.createOrUpdate': ['name'],
  'aiSearch.namespaces.instances.items.delete': ['name', 'id'],
  'aiSearch.namespaces.instances.items.download': ['name', 'id'],
  'aiSearch.namespaces.instances.items.get': ['name', 'id'],
  'aiSearch.namespaces.instances.items.list': ['name'],
  'aiSearch.namespaces.instances.items.logs': ['name', 'id'],
  'aiSearch.namespaces.instances.items.sync': ['name', 'id'],
  'aiSearch.namespaces.instances.items.upload': ['name'],
  'aiSearch.namespaces.instances.jobs.create': ['name'],
  'aiSearch.namespaces.instances.jobs.get': ['name', 'id'],
  'aiSearch.namespaces.instances.jobs.list': ['name'],
  'aiSearch.namespaces.instances.jobs.logs': ['name', 'id'],
  'aiSearch.namespaces.instances.jobs.update': ['name', 'id'],
  'aiSearch.namespaces.instances.read': ['name'],
  'aiSearch.namespaces.instances.search': ['name'],
  'aiSearch.namespaces.instances.stats': ['name'],
  'aiSearch.namespaces.instances.update': ['name'],
  'browserRendering.devtools.browser.page.get': ['session_id'],
  'browserRendering.devtools.browser.targets.activate': ['session_id'],
  'browserRendering.devtools.browser.targets.close': ['session_id'],
  'browserRendering.devtools.browser.targets.get': ['session_id'],
  'cloudforceOne.requests.assets.delete': ['request_id'],
  'cloudforceOne.requests.assets.get': ['request_id'],
  'cloudforceOne.requests.assets.update': ['request_id'],
  'cloudforceOne.requests.message.delete': ['request_id'],
  'cloudforceOne.requests.message.update': ['request_id'],
  'cloudforceOne.threatEvents.datasets.raw': ['dataset_id'],
  'cloudforceOne.threatEvents.raw.edit': ['event_id'],
  'cloudforceOne.threatEvents.raw.get': ['event_id'],
  'customHostnames.certificatePack.certificates.delete': ['custom_hostname_id', 'certificate_pack_id'],
  'customHostnames.certificatePack.certificates.update': ['custom_hostname_id', 'certificate_pack_id'],
  'firewall.waf.packages.groups.edit': ['package_id'],
  'firewall.waf.packages.groups.get': ['package_id'],
  'firewall.waf.packages.rules.edit': ['package_id'],
  'firewall.waf.packages.rules.get': ['package_id'],
  'flagship.apps.flags.changelog.list': ['app_id'],
  'flagship.apps.flags.delete': ['app_id'],
  'flagship.apps.flags.get': ['app_id'],
  'flagship.apps.flags.update': ['app_id'],
  'hostnames.settings.tls.delete': ['setting_id'],
  'hostnames.settings.tls.update': ['setting_id'],
  'iam.userGroups.members.delete': ['user_group_id'],
  'iam.userGroups.members.get': ['user_group_id'],
  'kv.namespaces.metadata.get': ['namespace_id'],
  'kv.namespaces.values.delete': ['namespace_id'],
  'kv.namespaces.values.get': ['namespace_id'],
  'kv.namespaces.values.update': ['namespace_id'],
  'magicTransit.cf1Sites.ramps.delete': ['cf1_site_id'],
  'magicTransit.cf1Sites.ramps.get': ['cf1_site_id'],
  'magicTransit.connectors.events.get': ['connector_id', 'event_t'],
  'magicTransit.connectors.snapshots.get': ['connector_id'],
  'magicTransit.sites.acls.delete': ['site_id'],
  'magicTransit.sites.acls.edit': ['site_id'],
  'magicTransit.sites.acls.get': ['site_id'],
  'magicTransit.sites.acls.update': ['site_id'],
  'magicTransit.sites.lans.delete': ['site_id'],
  'magicTransit.sites.lans.edit': ['site_id'],
  'magicTransit.sites.lans.get': ['site_id'],
  'magicTransit.sites.lans.update': ['site_id'],
  'magicTransit.sites.wans.delete': ['site_id'],
  'magicTransit.sites.wans.edit': ['site_id'],
  'magicTransit.sites.wans.get': ['site_id'],
  'magicTransit.sites.wans.update': ['site_id'],
  'organizations.logs.audit.history': ['organization_id'],
  'pages.projects.deployments.delete': ['project_name'],
  'pages.projects.deployments.get': ['project_name'],
  'pages.projects.deployments.history.logs.get': ['project_name'],
  'pages.projects.deployments.retry': ['project_name'],
  'pages.projects.deployments.rollback': ['project_name'],
  'pages.projects.domains.delete': ['project_name'],
  'pages.projects.domains.edit': ['project_name'],
  'pages.projects.domains.get': ['project_name'],
  'queues.consumers.delete': ['queue_id'],
  'queues.consumers.get': ['queue_id'],
  'queues.consumers.update': ['queue_id'],
  'r2.buckets.domains.custom.delete': ['bucket_name'],
  'r2.buckets.domains.custom.get': ['bucket_name'],
  'r2.buckets.domains.custom.update': ['bucket_name'],
  'r2.buckets.eventNotifications.delete': ['bucket_name'],
  'r2.buckets.eventNotifications.get': ['bucket_name'],
  'r2.buckets.eventNotifications.update': ['bucket_name'],
  'r2.buckets.objects.delete': ['bucket_name'],
  'r2.buckets.objects.get': ['bucket_name'],
  'r2.buckets.objects.upload': ['bucket_name'],
  'r2DataCatalog.namespaces.tables.list': ['bucket_name'],
  'r2DataCatalog.namespaces.tables.maintenanceConfigs.get': ['bucket_name', 'namespace'],
  'r2DataCatalog.namespaces.tables.maintenanceConfigs.update': ['bucket_name', 'namespace'],
  'realtimeKit.activeSession.createPoll': ['app_id'],
  'realtimeKit.activeSession.getActiveSession': ['app_id'],
  'realtimeKit.activeSession.kickAllParticipants': ['app_id'],
  'realtimeKit.activeSession.kickParticipants': ['app_id'],
  'realtimeKit.livestreams.getActiveLivestreamsForLivestreamID': ['app_id'],
  'realtimeKit.livestreams.getLivestreamSessionDetailsForSessionID': ['app_id'],
  'realtimeKit.livestreams.getLivestreamSessionForLivestreamID': ['app_id'],
  'realtimeKit.livestreams.getMeetingActiveLivestreams': ['app_id'],
  'realtimeKit.livestreams.startLivestreamingAMeeting': ['app_id'],
  'realtimeKit.livestreams.stopLivestreamingAMeeting': ['app_id'],
  'realtimeKit.meetings.addParticipant': ['app_id'],
  'realtimeKit.meetings.deleteMeetingParticipant': ['app_id', 'meeting_id'],
  'realtimeKit.meetings.editParticipant': ['app_id', 'meeting_id'],
  'realtimeKit.meetings.getMeetingByID': ['app_id'],
  'realtimeKit.meetings.getMeetingParticipant': ['app_id', 'meeting_id'],
  'realtimeKit.meetings.getMeetingParticipants': ['app_id'],
  'realtimeKit.meetings.refreshParticipantToken': ['app_id', 'meeting_id'],
  'realtimeKit.meetings.replaceMeetingByID': ['app_id'],
  'realtimeKit.meetings.updateMeetingByID': ['app_id'],
  'realtimeKit.presets.delete': ['app_id'],
  'realtimeKit.presets.getPresetByID': ['app_id'],
  'realtimeKit.presets.update': ['app_id'],
  'realtimeKit.recordings.getActiveRecordings': ['app_id'],
  'realtimeKit.recordings.getOneRecording': ['app_id'],
  'realtimeKit.recordings.pauseResumeStopRecording': ['app_id'],
  'realtimeKit.sessions.generateSummaryOfTranscripts': ['app_id'],
  'realtimeKit.sessions.getParticipantDataFromPeerID': ['app_id'],
  'realtimeKit.sessions.getSessionChat': ['app_id'],
  'realtimeKit.sessions.getSessionDetails': ['app_id'],
  'realtimeKit.sessions.getSessionParticipantDetails': ['app_id', 'session_id'],
  'realtimeKit.sessions.getSessionParticipants': ['app_id'],
  'realtimeKit.sessions.getSessionSummary': ['app_id'],
  'realtimeKit.sessions.getSessionTranscripts': ['app_id'],
  'realtimeKit.webhooks.deleteWebhook': ['app_id'],
  'realtimeKit.webhooks.editWebhook': ['app_id'],
  'realtimeKit.webhooks.getWebhookByID': ['app_id'],
  'realtimeKit.webhooks.replaceWebhook': ['app_id'],
  'resourceSharing.recipients.delete': ['share_id'],
  'resourceSharing.recipients.get': ['share_id'],
  'resourceSharing.resources.delete': ['share_id'],
  'resourceSharing.resources.get': ['share_id'],
  'resourceSharing.resources.update': ['share_id'],
  'rules.lists.items.get': ['list_id'],
  'rulesets.rules.edit': ['ruleset_id'],
  'rum.rules.delete': ['ruleset_id'],
  'rum.rules.update': ['ruleset_id'],
  'secretsStore.stores.secrets.delete': ['store_id'],
  'secretsStore.stores.secrets.duplicate': ['store_id'],
  'secretsStore.stores.secrets.edit': ['store_id'],
  'secretsStore.stores.secrets.get': ['store_id'],
  'speed.pages.tests.get': ['url'],
  'stream.audioTracks.delete': ['identifier'],
  'stream.audioTracks.edit': ['identifier'],
  'stream.captions.language.create': ['identifier'],
  'stream.captions.language.delete': ['identifier'],
  'stream.captions.language.get': ['identifier'],
  'stream.captions.language.update': ['identifier'],
  'stream.captions.language.vtt.get': ['identifier'],
  'stream.liveInputs.outputs.delete': ['live_input_identifier'],
  'stream.liveInputs.outputs.update': ['live_input_identifier'],
  'tenantCustomNameservers.delete': ['tenant_tag'],
  'vulnerabilityScanner.credentialSets.credentials.delete': ['credential_set_id'],
  'vulnerabilityScanner.credentialSets.credentials.edit': ['credential_set_id'],
  'vulnerabilityScanner.credentialSets.credentials.get': ['credential_set_id'],
  'vulnerabilityScanner.credentialSets.credentials.update': ['credential_set_id'],
  'waitingRooms.events.delete': ['waiting_room_id'],
  'waitingRooms.events.details.get': ['waiting_room_id'],
  'waitingRooms.events.edit': ['waiting_room_id'],
  'waitingRooms.events.get': ['waiting_room_id'],
  'waitingRooms.events.update': ['waiting_room_id'],
  'waitingRooms.rules.delete': ['waiting_room_id'],
  'waitingRooms.rules.edit': ['waiting_room_id'],
  'web3.hostnames.ipfsUniversalPaths.contentLists.entries.delete': ['identifier'],
  'web3.hostnames.ipfsUniversalPaths.contentLists.entries.get': ['identifier'],
  'web3.hostnames.ipfsUniversalPaths.contentLists.entries.update': ['identifier'],
  'workers.beta.workers.versions.delete': ['worker_id'],
  'workers.beta.workers.versions.get': ['worker_id'],
  'workers.scripts.deployments.delete': ['script_name'],
  'workers.scripts.deployments.get': ['script_name'],
  'workers.scripts.secrets.delete': ['script_name'],
  'workers.scripts.secrets.get': ['script_name'],
  'workers.scripts.tail.delete': ['script_name'],
  'workers.scripts.versions.get': ['script_name'],
  'workersForPlatforms.dispatch.namespaces.scripts.assetUpload.create': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.bindings.get': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.content.get': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.content.update': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.delete': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.get': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.secrets.bulkUpdate': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.secrets.delete': ['dispatch_namespace', 'script_name'],
  'workersForPlatforms.dispatch.namespaces.scripts.secrets.get': ['dispatch_namespace', 'script_name'],
  'workersForPlatforms.dispatch.namespaces.scripts.secrets.list': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.secrets.update': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.settings.edit': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.settings.get': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.tags.delete': ['dispatch_namespace', 'script_name'],
  'workersForPlatforms.dispatch.namespaces.scripts.tags.list': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.tags.update': ['dispatch_namespace'],
  'workersForPlatforms.dispatch.namespaces.scripts.update': ['dispatch_namespace'],
  'workflows.instances.events.create': ['workflow_name', 'instance_id'],
  'workflows.instances.get': ['workflow_name'],
  'workflows.instances.status.edit': ['workflow_name'],
  'workflows.instances.step': ['workflow_name'],
  'workflows.versions.get': ['workflow_name'],
  'workflows.versions.graph': ['workflow_name'],
  'zeroTrust.access.applications.policies.update': ['app_id'],
  'zeroTrust.access.users.activeSessions.get': ['user_id'],
  'zeroTrust.dex.commands.downloads.get': ['command_id'],
  'zeroTrust.dlp.dataTagCategories.dataTags.delete': ['category_id'],
  'zeroTrust.dlp.dataTagCategories.dataTags.get': ['category_id'],
  'zeroTrust.dlp.dataTagCategories.dataTags.update': ['category_id'],
  'zeroTrust.dlp.datasets.upload.edit': ['dataset_id'],
  'zeroTrust.dlp.datasets.versions.create': ['dataset_id'],
  'zeroTrust.dlp.datasets.versions.entries.create': ['dataset_id', 'version'],
  'zeroTrust.dlp.sensitivityGroups.levels.delete': ['sensitivity_group_id'],
  'zeroTrust.dlp.sensitivityGroups.levels.get': ['sensitivity_group_id'],
  'zeroTrust.dlp.sensitivityGroups.levels.update': ['sensitivity_group_id'],
  'zeroTrust.tunnels.cloudflared.connectors.get': ['tunnel_id'],
  'zeroTrust.tunnels.warpConnector.connectors.get': ['tunnel_id'],
};


// stripe-legacy-card-iin-removal covers: the v2348 -> v2349 spec replay
// recorded 1608 breaking rows (#60282-#61889); 1603 of them are per-operation
// response projections of ONE schema change (the legacy shared "card" source
// schema losing its iin property). The other five rows in the range are the
// proof_of_registration create-param removal (#60910-#60913) and the checkout
// dynamic_tax_rates removal (#61039), covered by their own llm-fix assets.
// Enumerating 1603 literals would be noise; the contiguous range minus the
// five exclusions is the same explicit declaration, mechanically.
const CARD_IIN_COVERS = (() => {
  const skip = new Set([60910, 60911, 60912, 60913, 61039]);
  const out = [];
  for (let id = 60282; id <= 61889; id++) if (!skip.has(id)) out.push(id);
  return out;
})();

const MIGRATIONS = {
  'openai-v3-to-v4': {
    provider: 'openai',
    title: 'openai-node v3 -> v4 SDK migration',
    reference: 'https://github.com/openai/openai-node/discussions/217',
    rules: [
      {
        desc: 'Replace Configuration/OpenAIApi require with OpenAI default import',
        detect: /require\(['"]openai['"]\)/,
        apply: (t) => t
          .replace(/const\s*\{\s*Configuration\s*,\s*OpenAIApi\s*\}\s*=\s*require\(['"]openai['"]\);?/g,
            "const OpenAI = require('openai');")
          .replace(/import\s*\{\s*Configuration\s*,\s*OpenAIApi\s*\}\s*from\s*['"]openai['"];?/g,
            "import OpenAI from 'openai';"),
      },
      {
        desc: 'Replace Configuration + OpenAIApi instantiation with new OpenAI()',
        detect: /new\s+Configuration\s*\(/,
        apply: (t) => t.replace(
          /const\s+(\w+)\s*=\s*new\s+Configuration\s*\(\s*\{([\s\S]*?)\}\s*\);\s*\n\s*const\s+(\w+)\s*=\s*new\s+OpenAIApi\s*\(\s*\1\s*\);?/g,
          (_m, _cfg, cfgBody, client) => `const ${client} = new OpenAI({${cfgBody}});`,
        ),
      },
      {
        desc: 'createChatCompletion -> chat.completions.create (syntax-aware)',
        detect: /\.createChatCompletion\s*\(/,
        apply: (t) => renameCall(t, /\.createChatCompletion\b/, '.chat.completions.create'),
      },
      {
        desc: 'createCompletion -> completions.create (syntax-aware)',
        detect: /\.createCompletion\s*\(/,
        apply: (t) => renameCall(t, /\.createCompletion\b/, '.completions.create'),
      },
      {
        desc: 'createEmbedding -> embeddings.create (syntax-aware)',
        detect: /\.createEmbedding\s*\(/,
        apply: (t) => renameCall(t, /\.createEmbedding\b/, '.embeddings.create'),
      },
      {
        desc: 'Drop axios-style .data wrapper on responses',
        detect: /response\.data\.(choices|data)\b/,
        apply: (t) => t
          .replace(/response\.data\.choices/g, 'response.choices')
          .replace(/response\.data\.data/g, 'response.data'),
      },
    ],
  },
  'stripe-v7-to-v8': {
    provider: 'stripe',
    title: 'stripe-node v7 -> v8 SDK migration',
    reference: 'https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v8',
    rules: [
      {
        desc: 'Fold stripe.setApiVersion() into the constructor config object',
        detect: /\.setApiVersion\s*\(/,
        apply: (t) => t.replace(
          /(const\s+(\w+)\s*=\s*require\(['"]stripe['"]\)\(([^)]*)\);?)\s*\n\s*\2\.setApiVersion\s*\(\s*([^)]+)\s*\);?/g,
          (_m, _decl, client, key, ver) => `const ${client} = require('stripe')(${key.trim()}, { apiVersion: ${ver.trim()} });`,
        ),
      },
      {
        desc: 'Fold stripe.setTimeout() into constructor config (timeout option)',
        detect: /\.setTimeout\s*\(/,
        apply: (t) => t.replace(
          /(const\s+(\w+)\s*=\s*require\(['"]stripe['"]\)\(([^)]*?)(?:,\s*(\{[^}]*\}))?\);?)\s*\n\s*\2\.setTimeout\s*\(\s*([^)]+)\s*\);?/g,
          (_m, _decl, client, key, cfg, ms) => {
            const extra = cfg ? `${cfg.trim().slice(0, -1).trim().replace(/,\s*$/, '')}, timeout: ${ms.trim()} }` : `{ timeout: ${ms.trim()} }`;
            return `const ${client} = require('stripe')(${key.trim()}, ${extra});`;
          },
        ),
      },
      {
        desc: 'Fold stripe.setMaxNetworkRetries() into constructor config (maxNetworkRetries option)',
        detect: /\.setMaxNetworkRetries\s*\(/,
        apply: (t) => t.replace(
          /(const\s+(\w+)\s*=\s*require\(['"]stripe['"]\)\(([^)]*?)(?:,\s*(\{[^}]*\}))?\);?)\s*\n\s*\2\.setMaxNetworkRetries\s*\(\s*([^)]+)\s*\);?/g,
          (_m, _decl, client, key, cfg, n) => {
            const extra = cfg ? `${cfg.trim().slice(0, -1).trim().replace(/,\s*$/, '')}, maxNetworkRetries: ${n.trim()} }` : `{ maxNetworkRetries: ${n.trim()} }`;
            return `const ${client} = require('stripe')(${key.trim()}, ${extra});`;
          },
        ),
      },
      {
        desc: 'Fold stripe.setHttpAgent() into constructor config (httpAgent option)',
        detect: /\.setHttpAgent\s*\(/,
        apply: (t) => t.replace(
          /(const\s+(\w+)\s*=\s*require\(['"]stripe['"]\)\(([^)]*?)(?:,\s*(\{[^}]*\}))?\);?)\s*\n\s*\2\.setHttpAgent\s*\(\s*([^)]+)\s*\);?/g,
          (_m, _decl, client, key, cfg, agent) => {
            const extra = cfg ? `${cfg.trim().slice(0, -1).trim().replace(/,\s*$/, '')}, httpAgent: ${agent.trim()} }` : `{ httpAgent: ${agent.trim()} }`;
            return `const ${client} = require('stripe')(${key.trim()}, ${extra});`;
          },
        ),
      },
    ],
  },
  'aws-sdk-v2-to-v3-s3': {
    provider: 'aws',
    title: 'AWS SDK for JavaScript v2 -> v3 migration (S3)',
    reference: 'https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrating-to-v3.html',
    rules: [
      {
        desc: 'Rewrite s3.<op>(params).promise() to s3.send(new <Op>Command(params))',
        detect: /\.(getObject|putObject|deleteObject|listObjectsV2|headObject|copyObject)\s*\(([\s\S]*?)\)\s*\.promise\s*\(\)/,
        apply: (t) => t.replace(
          /\b(\w+)\.(getObject|putObject|deleteObject|listObjectsV2|headObject|copyObject)\s*\(([\s\S]*?)\)\s*\.promise\s*\(\)/g,
          (_m, client, op, params) => {
            const cmd = op.charAt(0).toUpperCase() + op.slice(1) + 'Command';
            return `${client}.send(new ${cmd}(${params}))`;
          },
        ),
      },
      {
        desc: 'Rewrite response Body.toString() to Body.transformToString() (v3 Body is a stream)',
        detect: /\.Body\.toString\s*\(/,
        apply: (t) => t.replace(/\.Body\.toString\s*\(/g, '.Body.transformToString('),
      },
      {
        desc: 'Replace new AWS.S3() client with new S3Client()',
        detect: /new\s+AWS\.S3\s*\(/,
        apply: (t) => t.replace(/new\s+AWS\.S3\s*\(/g, 'new S3Client('),
      },
      {
        desc: 'Replace aws-sdk require with modular @aws-sdk/client-s3 imports (only when no other AWS.* usage remains)',
        detect: /require\(['"]aws-sdk['"]\)/,
        apply: (t) => {
          const requireLine = /const\s+AWS\s*=\s*require\(['"]aws-sdk['"]\);?/g;
          // Conservative: if the file still references the AWS namespace after
          // the earlier rules ran (e.g. other services), leave the require alone.
          if (/\bAWS\./.test(t.replace(requireLine, ''))) return t;
          const used = new Set(['S3Client']);
          for (const m of t.matchAll(/new\s+(\w+Command)\s*\(/g)) used.add(m[1]);
          const imports = [...used].sort().join(', ');
          return t.replace(requireLine, `const { ${imports} } = require('@aws-sdk/client-s3');`);
        },
      },
    ],
  },
  'stripe-node-v22-httpclient-interface': {
    provider: 'stripe',
    title: 'stripe-node v22.3.1: HttpClient / HttpClientResponse exported as interfaces — extends becomes implements',
    reference: 'https://github.com/stripe/stripe-node/compare/v22.3.0...v22.3.1 (PR #2779; src/stripe.core.ts now aliases Stripe.HttpClient to HttpClientInterface)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #134 is the v22.3.1 release. Verified against the upstream
    // compare diff: Stripe.HttpClient and Stripe.HttpClientResponse type
    // exports now point at the minimal interfaces instead of the concrete
    // classes, so custom transport classes declared with
    // `extends Stripe.HttpClient` fail to type-check. The deterministic
    // mend is the extends -> implements keyword swap on those exact
    // qualified names. Value-position uses (instanceof checks, super()
    // calls into the removed concrete base) need structural rewrites and
    // stay on the AST/LLM track; a class that combines extends with an
    // existing implements clause needs clause merging and is also left
    // alone (the rule skips lines already carrying `implements`).
    covers: [134],
    // Re-verified 2026-07-30 against stripe-node v22.4.0 (change #60020,
    // API version 2026-07-29.dahlia): the release removes
    // AccountCreateParams.documents.proof_of_registration and touches no
    // HttpClient / HttpClientResponse type export, so the extends->implements
    // rewrite target is unchanged.
    revalidatedThrough: '2026-07-30',
    rules: [
      {
        desc: 'Rewrite `extends Stripe.HttpClient` / `extends Stripe.HttpClientResponse` class clauses to `implements`',
        // Conservative guards: the file must import/require the stripe
        // package, the rewrite is anchored on the exact Stripe.-qualified
        // type name (word boundary keeps Stripe.HttpClientConfig-style
        // names safe), and lines that already contain an `implements`
        // clause are skipped — merging two clauses is an AST-track job.
        detect: /extends\s+Stripe\s*\.\s*HttpClient(?:Response)?\b/,
        apply: (t) => {
          if (!/(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t)) return t;
          return t.split('\n').map((line) => {
            if (/\bimplements\b/.test(line)) return line;
            return line.replace(
              /\bextends(\s+Stripe\s*\.\s*HttpClient(?:Response)?)\b(?!\s*[.(])/g,
              'implements$1',
            );
          }).join('\n');
        },
      },
    ],
  },
  'stripe-us-bank-preferred-settlement-speed-removal': {
    provider: 'stripe',
    title: 'Stripe PaymentIntents: us_bank_account.preferred_settlement_speed withdrawn from the API surface (v2154)',
    reference: 'https://github.com/stripe/openapi (spec3.json snapshots v2153 vs v2154: payment_intent_payment_method_options_us_bank_account and every request/response surface embedding it)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #44360-#44370, #44379-#44406 and #44423 record the
    // one-sweep removal of
    // payment_method_options.us_bank_account.preferred_settlement_speed:
    // the token appears 4 times in the v2153 OAS and zero times from
    // v2154 onward, with no successor property (the sibling props
    // financial_connections, mandate_options, setup_future_usage,
    // target_date and verification_method are unchanged). The three
    // payment-intent request surfaces declare additionalProperties:false,
    // so keeping the property in payloads is rejected upstream. The mend
    // deletes the dead property from request payloads and removes reads
    // of it from response handling; settlement timing is managed by
    // Stripe at the account level, outside code reach.
    covers: [44360, 44361, 44362, 44363, 44364, 44365, 44366, 44367, 44368, 44369, 44370, 44379, 44380, 44381, 44382, 44383, 44384, 44385, 44386, 44387, 44388, 44389, 44390, 44391, 44392, 44393, 44394, 44395, 44396, 44397, 44398, 44399, 44400, 44401, 44402, 44403, 44404, 44405, 44406, 44423],
    // Re-verified against cached v2348/v2349 snapshots (2026-07-29.dahlia
    // batch): "preferred_settlement_speed" token count stays 0 in both —
    // the removal this pack mends is untouched by the newer spec-diff
    // records (all of which are the unrelated card iin sweep).
    revalidatedThrough: '2026-07-30',
    rules: [
      {
        desc: 'Remove preferred_settlement_speed payload properties and reads from Stripe payment-intent consumers',
        // Conservative guards: only rewrite files that clearly talk to
        // the Stripe API (stripe import/require, api.stripe.com, or a
        // stripe client member chain). Removal shapes are all
        // line-bounded; lines with unbalanced brackets (multi-line
        // values) and bare `case '<label>':` switch labels are left to
        // the AST track rather than break syntax or merge branches.
        detect: /\bpreferred_settlement_speed\b/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          if (!stripeCtx) return t;
          const TOKEN = 'preferred_settlement_speed';
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          return t.split('\n').map((line) => {
            if (!new RegExp(`\\b${TOKEN}\\b`).test(line)) return line;
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // destructuring / inline identifier lists: drop the name, keep siblings
            let out = line.replace(/\{([^{}]*\bpreferred_settlement_speed\b[^{}]*)\}/g, (m, names) => {
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n && n !== TOKEN);
              return `{ ${list.join(', ')} }`;
            });
            // single-line object property (inline form): drop the entry, keep siblings
            out = out
              .replace(/\bpreferred_settlement_speed\s*:\s*[^,}\n]+?\s*,\s*/g, '')
              .replace(/,\s*preferred_settlement_speed\s*:\s*[^,}\n]+/g, '')
              .replace(/\{\s*preferred_settlement_speed\s*:\s*[^,}\n]+?\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // remaining balanced lines referencing the token are dead
            // reads/writes (property line, conditional, display statement)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
    ],
  },
  'stripe-terminal-tipping-bgn-removal': {
    provider: 'stripe',
    title: 'Stripe Terminal configurations: the bgn tipping currency block removed (v2154, Bulgaria euro adoption)',
    reference: 'https://github.com/stripe/openapi (spec3.json snapshots v2153 vs v2154: terminal_configuration_configuration_resource_tipping currency blocks 22 -> 21, only bgn gone; eur retained in both versions)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #44371-#44378 and #44407-#44422 record the
    // removal of the bgn (Bulgarian lev) currency block from terminal
    // configuration tipping across every request/response surface
    // (create/update/get/list x bgn subtree). Verified against cached
    // OAS snapshots: the "bgn" token count drops 4 -> 0 across the whole
    // spec while the currency list shrinks 22 -> 21 and the eur block
    // survives in both versions — the API-surface reflection of Bulgaria
    // joining the euro area. Both terminal configuration request schemas
    // declare additionalProperties:false, so sending tipping[bgn] is
    // rejected after the change. The mend deletes bgn tipping payload
    // blocks and reads; presets for Bulgarian terminals move to the eur
    // block, and the lev-to-euro amount conversion is a business
    // decision left to the team (fixed BGN/EUR rate), so no automatic
    // eur rewrite is attempted.
    covers: [44371, 44372, 44373, 44374, 44375, 44376, 44377, 44378, 44407, 44408, 44409, 44410, 44411, 44412, 44413, 44414, 44415, 44416, 44417, 44418, 44419, 44420, 44421, 44422],
    // Re-verified against cached v2348/v2349 snapshots (2026-07-29.dahlia
    // batch): "bgn" token count stays 0 in both — the tipping-block
    // removal this pack mends is untouched by the newer spec-diff records
    // (all of which are the unrelated card iin sweep).
    revalidatedThrough: '2026-07-30',
    rules: [
      {
        desc: 'Remove bgn tipping currency blocks and reads from Stripe Terminal configuration consumers',
        // Conservative guards: the file must clearly talk to the Stripe
        // API AND mention tipping. Because "bgn" is a short token, every
        // rewritten line must additionally anchor to the tipping surface:
        // either a member chain through .tipping, a tipping-scoped
        // destructuring, or a single-line bgn block carrying the tipping
        // preset keys (percentages / fixed_amounts / smart_tip_threshold).
        // Unrelated currency tables that happen to use a bgn key never
        // match. Multi-line bgn blocks (unbalanced lines) are left to the
        // AST track.
        detect: /\bbgn\b/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          if (!stripeCtx || !/\btipping\b/.test(t)) return t;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const tippingAnchored = (line) =>
            /\btipping\b/.test(line) ||
            /\bbgn\s*:\s*\{[^{}\n]*\b(?:percentages|fixed_amounts|smart_tip_threshold)\b/.test(line);
          return t.split('\n').map((line) => {
            if (!/\bbgn\b/.test(line)) return line;
            if (!tippingAnchored(line)) return line; // not the tipping surface
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // destructuring off the tipping object: drop bgn, keep siblings
            let out = line.replace(/\{([^{}]*\bbgn\b[^{}]*)\}\s*=\s*([^;]*\btipping\b[^;]*);/g, (m, names, src) => {
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'bgn');
              return `{ ${list.join(', ')} } = ${src.trim()};`;
            });
            // single-line bgn tipping block property: drop the entry, keep siblings
            out = out
              .replace(/\bbgn\s*:\s*\{[^{}\n]*\}\s*,\s*/g, '')
              .replace(/,\s*bgn\s*:\s*\{[^{}\n]*\}/g, '')
              .replace(/\{\s*bgn\s*:\s*\{[^{}\n]*\}\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // remaining balanced tipping-anchored lines referencing bgn are
            // dead reads/writes (member reads, conditionals, display lines)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced bgn bindings from flat tipping destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone (multi-line patterns carry no tipping anchor
        // on the entry line). "bgn" is a short generic token — any ISO
        // currency table binds it — so this pass adds an anchor gate on top
        // of the primitive's own guards: EVERY flat destructuring pattern in
        // the file that binds bgn must have a right-hand side anchored to
        // the tipping surface; one unanchored pattern (an FX or rounding
        // table, say) and the whole file is skipped. Patterns that pass the
        // gate go through removeDestructuredProperty, which only removes a
        // binding when it is flat, default/rest-free and has zero other
        // code-region references.
        detect: /\{[^{}]*\bbgn\b[^{}]*\}\s*=/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          if (!stripeCtx || !/\btipping\b/.test(t)) return t;
          const pat = /\{[^{}]*\bbgn\b[^{}]*\}\s*=\s*([^;\n]*)/g;
          const anchor = /\btipping\b/;
          let sawPattern = false;
          let allAnchored = true;
          for (const m of t.matchAll(pat)) {
            sawPattern = true;
            if (!anchor.test(m[1])) { allAnchored = false; break; }
          }
          if (!sawPattern || !allAnchored) return t;
          return removeDestructuredProperty(t, 'bgn');
        },
      },
    ],
  },
  'stripe-payment-record-card-details-removal': {
    provider: 'stripe',
    title: 'Stripe payment records: card_details drops description, iin, issuer and stored_credential_usage (v2324)',
    reference: 'https://github.com/stripe/openapi (spec3.json snapshots v2323 vs v2324: payments_primitives_payment_records_resource_payment_method_card_details loses four properties in one change)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #47041-#47080 record the one-sweep removal of
    // description, iin, issuer and stored_credential_usage from the
    // payment-record card details schema
    // (payments_primitives_payment_records_resource_payment_method_card_details).
    // Verified against cached OAS snapshots: stored_credential_usage
    // spec-wide token count 1 -> 0; issuer property-bearing schemas
    // 13 -> 12; the only surviving iin property lives on the unrelated
    // legacy "card" source schema. The card-present (terminal) surfaces
    // keep description/issuer in both versions and the charge-surface
    // payment_method_details_card never had these fields, so the blast
    // radius is exactly the payment_records / payment_attempt_records
    // read and report responses (10 operations x 4 fields = 40 records).
    // The mend deletes reads of the four fields on payment-record
    // surfaces; there is no successor field, and values from other
    // surfaces are not semantically interchangeable, so no substitution
    // is attempted.
    covers: [47041, 47042, 47043, 47044, 47045, 47046, 47047, 47048, 47049, 47050, 47051, 47052, 47053, 47054, 47055, 47056, 47057, 47058, 47059, 47060, 47061, 47062, 47063, 47064, 47065, 47066, 47067, 47068, 47069, 47070, 47071, 47072, 47073, 47074, 47075, 47076, 47077, 47078, 47079, 47080],
    rules: [
      {
        desc: 'Remove reads of withdrawn payment-record card metadata fields (description/iin/issuer/stored_credential_usage)',
        // Conservative guards: the file must clearly talk to the Stripe
        // API AND mention the payment-record surface (paymentRecords /
        // payment_records / paymentAttemptRecords / payment_attempt_records)
        // before anything is rewritten. Every rewritten line must anchor
        // to a payment_method_details.card.<field> member chain — the
        // card-present surface never matches because `card_present` does
        // not satisfy the `card` segment, and generic tokens such as
        // `description` on unrelated objects never match without the full
        // chain. Lines with unbalanced brackets (multi-line values) and
        // bare `case '<label>':` switch labels are left to the AST track.
        detect: /payment_method_details\s*\??\.\s*card\s*\??\.\s*(?:description|iin|issuer|stored_credential_usage)\b|\bpayment_method_details\s*\??\.\s*card\b/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          const recordCtx = /payment_?attempt_?records|payment_?records|paymentAttemptRecords|paymentRecords/i.test(t);
          if (!stripeCtx || !recordCtx) return t;
          const FIELDS = ['description', 'iin', 'issuer', 'stored_credential_usage'];
          const CHAIN = /payment_method_details\s*\??\.\s*card\s*\??\.\s*(?:description|iin|issuer|stored_credential_usage)\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring off the card object is left untouched: the
            // binding names (issuer, description, ...) are generic
            // tokens, so downstream uses of a dropped binding cannot be
            // safely cleaned up without an AST. Reading a removed
            // property through destructuring degrades to undefined
            // rather than breaking, so leaving the line is the safe
            // conservative direction (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads a withdrawn field:
            // drop the entry, keep siblings
            let out = line
              .replace(/\b[\w$]+\s*:\s*[^,{}\n]*payment_method_details\s*\??\.\s*card\s*\??\.\s*(?:description|iin|issuer|stored_credential_usage)\b[^,}\n]*\s*,\s*/g, '')
              .replace(/,\s*[\w$]+\s*:\s*[^,{}\n]*payment_method_details\s*\??\.\s*card\s*\??\.\s*(?:description|iin|issuer|stored_credential_usage)\b[^,}\n]*/g, '')
              .replace(/\{\s*[\w$]+\s*:\s*[^,{}\n]*payment_method_details\s*\??\.\s*card\s*\??\.\s*(?:description|iin|issuer|stored_credential_usage)\b[^,}\n]*\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations (const/let/var x = ...card.<field>...)
            // are never dropped: downstream references to the binding
            // would become ReferenceErrors. Left to the AST track, which
            // can rewrite the initializer and its consumers together.
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading a withdrawn field are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-field bindings from flat card-details destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The four withdrawn field names are generic
        // tokens, so this pass adds an anchor gate on top of the primitive's
        // own guards: for each field, EVERY flat destructuring pattern in the
        // file that binds the name must have a right-hand side anchored to
        // the payment_method_details.card member chain — one unanchored
        // pattern (a `description` pulled off an unrelated object, say) and
        // the field is skipped for the whole file. Patterns that pass the
        // gate go through removeDestructuredProperty, which only removes a
        // binding when it is flat, default/rest-free and has zero other
        // code-region references (member access and string/comment mentions
        // never count).
        detect: /\{[^{}]*\b(?:description|iin|issuer|stored_credential_usage)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          const recordCtx = /payment_?attempt_?records|payment_?records|paymentAttemptRecords|paymentRecords/i.test(t);
          if (!stripeCtx || !recordCtx) return t;
          let out = t;
          for (const field of ['description', 'iin', 'issuer', 'stored_credential_usage']) {
            const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
            const anchor = /payment_method_details\s*\??\.\s*card\b/;
            let sawPattern = false;
            let allAnchored = true;
            for (const m of out.matchAll(pat)) {
              sawPattern = true;
              if (!anchor.test(m[1])) { allAnchored = false; break; }
            }
            if (!sawPattern || !allAnchored) continue;
            out = removeDestructuredProperty(out, field);
          }
          return out;
        },
      },
    ],
  },
  'stripe-payment-record-boleto-tax-id-null-guard': {
    provider: 'stripe',
    title: 'Stripe payment records: boleto tax_id became nullable on payment-record surfaces (v2183) — guard dereferences with optional chaining',
    reference: 'https://github.com/stripe/openapi (spec3.json snapshots v2182 vs v2183: v2183 introduces the dedicated projection schema payment_method_details_payment_record_boleto with tax_id nullable:true and absent from required; the shared payment_method_boleto and payment_method_details_boleto schemas keep tax_id required and non-nullable in both versions)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #46650-#46659 are the per-operation projection of
    // one schema change: boleto tax_id relaxed to nullable ONLY on the
    // payment_records / payment_attempt_records read and report surfaces.
    // Verified against cached OAS snapshots, token-level: the new
    // projection schema payment_method_details_payment_record_boleto has
    // tax_id nullable:true and no required list, while the charge-surface
    // payment_method_details_boleto keeps tax_id required/non-nullable in
    // both versions - charge-surface reads need no guard and are never
    // touched (file-level guard requires a payment-record surface token).
    // The mend is a REWRITE, not a delete: any further dereference off
    // tax_id (`...boleto.tax_id.trim()` and the like) gets an optional
    // chain (`tax_id?.trim()`), turning a would-be TypeError on the new
    // null value into an undefined that downstream null checks can see.
    // Reads without a further dereference (comparisons, assignments of
    // the bare value) are already null-safe and are left untouched.
    // Multi-step dataflow (const t = ...tax_id; t.trim()) is left to the
    // AST track - miss, never mangle.
    covers: [46650, 46651, 46652, 46653, 46654, 46655, 46656, 46657, 46658, 46659],
    // Re-verified against cached v2348/v2349 snapshots (2026-07-29.dahlia
    // batch): payment_method_details_payment_record_boleto keeps tax_id
    // nullable/not-required and the charge-surface schema keeps it
    // required in both versions — the null-guard target is untouched by
    // the newer spec-diff records (the unrelated card iin sweep).
    revalidatedThrough: '2026-07-30',
    rules: [
      {
        desc: 'Guard dereferences of payment-record boleto tax_id with optional chaining (tax_id.<x> -> tax_id?.<x>)',
        // Conservative guards: the file must clearly talk to the Stripe
        // API AND mention the payment-record surface before anything is
        // rewritten (same double gate as the card-details pack). Every
        // rewritten site must anchor on the full
        // payment_method_details.boleto.tax_id member chain followed by
        // a further dereference - charge-surface files never carry the
        // payment-record token, and unrelated tax_id fields never carry
        // the full chain. Naturally idempotent: after the rewrite the
        // dot following tax_id is `?.`, which the pattern no longer
        // matches.
        detect: /payment_method_details\s*\??\.\s*boleto\s*\??\.\s*tax_id\s*\.\s*[A-Za-z_$]/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          const recordCtx = /payment_?attempt_?records|payment_?records|paymentAttemptRecords|paymentRecords/i.test(t);
          if (!stripeCtx || !recordCtx) return t;
          const DEREF = /(payment_method_details\s*\??\.\s*boleto\s*\??\.\s*tax_id)\s*\.(\s*[A-Za-z_$])/g;
          return t.split('\n').map((line) => {
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // comment lines
            return line.replace(DEREF, (_m, chain, tail) => `${chain}?.${tail}`);
          }).join('\n');
        },
      },
    ],
  },
  'stripe-legacy-card-iin-removal': {
    provider: 'stripe',
    title: 'Stripe legacy card objects drop the iin property (v2349)',
    reference: 'https://github.com/stripe/openapi (spec3.json snapshots v2348 vs v2349: the shared legacy \"card\" source schema loses its iin property - spec-wide \"iin\" property token count 1 -> 0, schemas carrying an iin property go [card] -> [])',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #60282-#61889 minus the five unrelated rows (see
    // CARD_IIN_COVERS above) are the per-operation response projections of
    // the single legacy card schema change. Token-verified against cached
    // OAS snapshots (loop/cache/specs v2348/v2349): iin count 1 -> 0
    // spec-wide with no successor - iin (first-six/BIN issuer metadata) is
    // PCI-scoped data Stripe no longer exposes on the card object. The
    // surviving card identity leaves (brand, funding, last4, exp_month,
    // exp_year) are unchanged in both versions. The mend deletes reads of
    // .iin on card objects however they are reached (customer
    // default_source, external accounts, error.source projections alike);
    // no substitution is attempted because no field carries the BIN.
    covers: CARD_IIN_COVERS,
    rules: [
      {
        desc: 'Remove reads of the withdrawn card.iin (BIN) property on Stripe card objects',
        // Conservative guards: the file must clearly talk to the Stripe API
        // before anything is rewritten. Every rewritten line must anchor on
        // a member-access read of .iin off a value expression - the token
        // \"iin\" (issuer identification number) does not occur as a member
        // name outside card BIN reads in Stripe-context files. Comment
        // lines, unbalanced lines (multi-line values), bare case labels and
        // destructuring patterns are left to the AST track; binding
        // declarations are kept so downstream references never become
        // ReferenceErrors (reading the removed property degrades to
        // undefined, the safe conservative direction).
        detect: /[\w$\])]\s*\??\.\s*iin\b/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['\"]stripe['\"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          if (!stripeCtx) return t;
          const READ = /[\w$\])]\s*\??\.\s*iin\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          return t.split('\n').map((line) => {
            if (/^[ \t]*(?:\/\/|\/\*|\*)/.test(line)) return line;
            if (!READ.test(line)) return line;
            if (!balanced(line)) return line;
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads .iin: drop the
            // entry, keep siblings
            let out = line
              .replace(/\b[\w$]+\s*:\s*[^,{}\n]*[\w$\])]\s*\??\.\s*iin\b[^,}\n]*\s*,\s*/g, '')
              .replace(/,\s*[\w$]+\s*:\s*[^,{}\n]*[\w$\])]\s*\??\.\s*iin\b[^,}\n]*/g, '')
              .replace(/\{\s*[\w$]+\s*:\s*[^,{}\n]*[\w$\])]\s*\??\.\s*iin\b[^,}\n]*\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading the withdrawn field are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced iin bindings from flat card-object destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. removeDestructuredProperty enforces its own
        // conservative guards: flat patterns only, no defaults/rest, and the
        // bound identifier must have zero other code-region references
        // (member access and string/comment mentions never count) — so
        // `const { iin, brand } = src; return { iin, brand };` survives
        // untouched while a genuinely dead `const { iin, brand } = src`
        // binding loses only the withdrawn field.
        detect: /\{[^{}]*\biin\b[^{}]*\}\s*=/,
        apply: (t) => {
          const stripeCtx = /(?:from\s*|require\s*\(\s*)['"]stripe['"]/.test(t) || /api\.stripe\.com/.test(t) || /\bstripe\s*\./.test(t);
          if (!stripeCtx) return t;
          return removeDestructuredProperty(t, 'iin');
        },
      },
    ],
  },
  'cloudflare-kv-legacy-routes': {
    provider: 'cloudflare',
    title: 'Cloudflare Workers KV legacy namespace routes -> storage/kv routes',
    reference: 'https://developers.cloudflare.com/changelog/post/2026-07-15-kv-legacy-namespace-routes-deprecation/',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1402 is the KV legacy-route deprecation this pack mends.
    covers: [1402],
    rules: [
      {
        desc: 'Rewrite /accounts/{id}/workers/namespaces* URLs to /accounts/{id}/storage/kv/namespaces*',
        // Cloudflare documents the migration as a direct URL path substitution
        // with identical request/response payloads. Conservative guard: only
        // rewrite files that clearly build Cloudflare account API URLs, and
        // only the exact legacy path segment.
        detect: /workers\/namespaces/,
        apply: (t) => {
          if (!/api\.cloudflare\.com/.test(t) && !/\/accounts\/|accounts\//.test(t)) return t;
          return t.replace(/workers\/namespaces/g, 'storage/kv/namespaces');
        },
      },
    ],
  },
  'shopify-customer-account-draftorder-price': {
    provider: 'shopify',
    title: 'Shopify Customer Account API: discountedUnitPrice -> approximateDiscountedUnitPrice',
    reference: 'https://shopify.dev/changelog/discountedunitprice-on-draftorderlineitem-customer-account-api-deprecation',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1350 deprecates DraftOrderLineItem.discountedUnitPrice in the
    // Customer Account API; Shopify documents the fix as a direct field
    // rename to approximateDiscountedUnitPrice.
    covers: [1350],
    rules: [
      {
        desc: 'Rename discountedUnitPrice field to approximateDiscountedUnitPrice in Customer Account API GraphQL usage',
        // Conservative guards: only rewrite files that clearly talk to the
        // Customer Account API (its GraphQL endpoint path or an explicit
        // customer-account marker) AND reference draft orders — the Admin API
        // has its own distinct DraftOrderLineItem surface this pack must not
        // touch. The \b boundary keeps discountedUnitPriceSet (a different
        // field) and the already-migrated approximateDiscountedUnitPrice
        // (capital D inside) untouched, which also makes the rule idempotent.
        detect: /\bdiscountedUnitPrice\b/,
        apply: (t) => {
          const customerAccountApi = /account\/customer\/api/.test(t) || /customer[\s-]account/i.test(t);
          const draftOrderContext = /draftOrder/i.test(t);
          if (!customerAccountApi || !draftOrderContext) return t;
          return t.replace(/\bdiscountedUnitPrice\b/g, 'approximateDiscountedUnitPrice');
        },
      },
    ],
  },
  'shopify-customer-last-incomplete-checkout': {
    provider: 'shopify',
    title: 'Shopify Customer Account API: remove Customer.lastIncompleteCheckout selections (Checkout subtree removed in 2026-10)',
    reference: 'https://shopify.dev/changelog/customer-account-api-customer-lastincompletecheckout-and-checkout-types-removed',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1340 removes the deprecated Customer.lastIncompleteCheckout
    // field (and the whole Checkout type subtree) from the Customer Account
    // API as of version 2026-10. The field already returned null, so Shopify's
    // documented action is to delete the selection from queries.
    covers: [1340],
    rules: [
      {
        desc: 'Delete lastIncompleteCheckout selections (including the nested Checkout selection block) from Customer Account API GraphQL queries',
        // Conservative guards: only rewrite files that clearly talk to the
        // Customer Account API (its GraphQL endpoint path or an explicit
        // customer-account marker). The removal is a brace-balanced subtree
        // delete so nested selections (appliedGiftCards, lineItems, ...) go
        // with the parent field; sibling fields are untouched. JS property
        // reads are NOT rewritten (deleting reads changes program semantics);
        // the changelog's action item is query cleanup only.
        detect: /\blastIncompleteCheckout\b/,
        apply: (t) => {
          const customerAccountApi = /account\/customer\/api/.test(t) || /customer[\s-]account/i.test(t);
          if (!customerAccountApi) return t;
          return removeGraphqlSelection(t, 'lastIncompleteCheckout');
        },
      },
    ],
  },
  'shopify-marketing-engagement-cumulative': {
    provider: 'shopify',
    title: 'Shopify Admin API: drop deprecated isCumulative argument on marketingEngagementCreate',
    reference: 'https://shopify.dev/changelog/deprecation-of-cumulative-marketing-engagements',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1347 deprecates the cumulative flag on marketingEngagementCreate,
    // defaulting it to false. Shopify asks integrations to send non-cumulative
    // engagements, so the mend is to remove the argument entirely.
    covers: [1347],
    rules: [
      {
        desc: 'Remove the deprecated cumulative flag from marketingEngagementCreate calls (GraphQL field, variable declaration, and JS variables object)',
        // Conservative guards: only rewrite files that clearly call the
        // marketingEngagementCreate mutation, and only remove the exact
        // argument shapes the changelog covers (boolean literal or a
        // pass-through $-variable). Anything else is left untouched.
        detect: /\bisCumulative\b/,
        apply: (t) => {
          if (!/marketingEngagementCreate/.test(t)) return t;
          return t
            // whole-line field/property: `isCumulative: <bool|$var>,`
            .replace(/^[ \t]*isCumulative\s*:\s*(?:true|false|\$isCumulative)\s*,?\s*\r?\n/gm, '')
            // GraphQL operation variable declaration: `, $isCumulative: Boolean!`
            .replace(/,\s*\$isCumulative\s*:\s*Boolean!?/g, '')
            .replace(/\$isCumulative\s*:\s*Boolean!?\s*,\s*/g, '')
            // inline object/GraphQL field forms: `, isCumulative: false` / `isCumulative: false,`
            .replace(/,\s*\bisCumulative\s*:\s*(?:true|false|\$isCumulative)\b/g, '')
            .replace(/\bisCumulative\s*:\s*(?:true|false|\$isCumulative)\b\s*,\s*/g, '')
            // bare GraphQL selection of the deprecated response field
            .replace(/^[ \t]*isCumulative[ \t]*\r?\n/gm, '');
        },
      },
    ],
  },
  'hubspot-blogposts-api-move': {
    provider: 'hubspot',
    title: 'HubSpot API client v13: cms.blogs.blogPostsApi methods moved to basicApi/batchApi/multiLanguageApi',
    reference: 'https://github.com/HubSpot/hubspot-api-nodejs/releases/tag/13.0.0',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #689 is the v13 release that relocates every blogPostsApi method.
    covers: [689],
    // Revalidation stamp: #682 (14.0.0, 2026-06-30) audited — Node 18->22
    // minimum bump only, no blogPosts surface change (fixability record).
    revalidatedThrough: '2026-06-30',
    // SDK method chains this pack rewrites (pre-migration form). `mendapi
    // deps --match` joins repo sdk-call surfaces against these with the same
    // tail-anchoring the rules use, so a hit means `mendapi fix` will touch
    // that line. The migrated forms (basicApi/batchApi/multiLanguageApi)
    // intentionally do not appear here — they must never join.
    chains: [
      // -> basicApi (moved, same name)
      'cms.blogs.blogPostsApi.archive', 'cms.blogs.blogPostsApi.callClone',
      'cms.blogs.blogPostsApi.create', 'cms.blogs.blogPostsApi.getById',
      'cms.blogs.blogPostsApi.pushLive', 'cms.blogs.blogPostsApi.resetDraft',
      'cms.blogs.blogPostsApi.schedule', 'cms.blogs.blogPostsApi.update',
      'cms.blogs.blogPostsApi.updateDraft',
      // -> batchApi (moved + Batch suffix dropped)
      'cms.blogs.blogPostsApi.archiveBatch', 'cms.blogs.blogPostsApi.createBatch',
      'cms.blogs.blogPostsApi.readBatch', 'cms.blogs.blogPostsApi.updateBatch',
      // -> multiLanguageApi (moved, same name)
      'cms.blogs.blogPostsApi.attachToLangGroup', 'cms.blogs.blogPostsApi.createLangVariation',
      'cms.blogs.blogPostsApi.detachFromLangGroup', 'cms.blogs.blogPostsApi.setLangPrimary',
      'cms.blogs.blogPostsApi.updateLangs',
    ],
    rules: [
      {
        desc: 'cms.blogs.blogPostsApi.<method> -> cms.blogs.basicApi.<method> (moved methods, syntax-aware)',
        // Conservative: only rewrite full `cms.blogs.blogPostsApi.` member
        // chains (the release notes describe exactly this path) and only the
        // methods HubSpot lists as moved. Unknown methods are left untouched.
        // Rewrites go through astlite renameCall, so mentions of the legacy
        // namespace inside strings, template literals, and comments survive
        // untouched (the classic blind-regex corruption mode).
        detect: /cms\.blogs\.blogPostsApi\.(?:archive|callClone|create|getById|pushLive|resetDraft|schedule|update|updateDraft)\s*\(/,
        apply: (t) => {
          let out = t;
          for (const m of ['archive', 'callClone', 'create', 'getById', 'pushLive', 'resetDraft', 'schedule', 'update', 'updateDraft']) {
            out = renameCall(out, new RegExp(`cms\\.blogs\\.blogPostsApi\\.${m}\\b`), `cms.blogs.basicApi.${m}`);
          }
          return out;
        },
      },
      {
        desc: 'cms.blogs.blogPostsApi.<x>Batch -> cms.blogs.batchApi.<x> (moved and renamed batch methods, syntax-aware)',
        detect: /cms\.blogs\.blogPostsApi\.(?:archiveBatch|createBatch|readBatch|updateBatch)\s*\(/,
        apply: (t) => {
          let out = t;
          for (const m of ['archiveBatch', 'createBatch', 'readBatch', 'updateBatch']) {
            out = renameCall(out, new RegExp(`cms\\.blogs\\.blogPostsApi\\.${m}\\b`), `cms.blogs.batchApi.${m.replace(/Batch$/, '')}`);
          }
          return out;
        },
      },
      {
        desc: 'cms.blogs.blogPostsApi language methods -> cms.blogs.multiLanguageApi (syntax-aware)',
        detect: /cms\.blogs\.blogPostsApi\.(?:attachToLangGroup|createLangVariation|detachFromLangGroup|setLangPrimary|updateLangs)\s*\(/,
        apply: (t) => {
          let out = t;
          for (const m of ['attachToLangGroup', 'createLangVariation', 'detachFromLangGroup', 'setLangPrimary', 'updateLangs']) {
            out = renameCall(out, new RegExp(`cms\\.blogs\\.blogPostsApi\\.${m}\\b`), `cms.blogs.multiLanguageApi.${m}`);
          }
          return out;
        },
      },
    ],
  },
  'shopify-order-fulfillment-not-required': {
    provider: 'shopify',
    title: 'Shopify Admin API: handle new OrderDisplayFulfillmentStatus value FULFILLMENT_NOT_REQUIRED (2026-10)',
    reference: 'https://shopify.dev/changelog/orderdisplayfulfillmentstatus-now-returns-fulfillment_not_required',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1342 adds the FULFILLMENT_NOT_REQUIRED enum value. Orders that
    // previously reported UNFULFILLED (nothing left to fulfill) report the new
    // value on 2026-10+. The mend inserts handling at exhaustive call sites
    // (switch statements and status maps) that mirrors the UNFULFILLED branch,
    // which preserves pre-2026-10 behavior exactly.
    covers: [1342],
    rules: [
      {
        desc: "Insert case 'FULFILLMENT_NOT_REQUIRED' as a fall-through before case 'UNFULFILLED' in switches over displayFulfillmentStatus",
        // Conservative guards: only rewrite files that clearly read the
        // displayFulfillmentStatus surface, and only when the new value is not
        // already handled anywhere in the file (which also makes the rule
        // idempotent). The inserted case falls through to the UNFULFILLED
        // branch — exactly what these orders resolved to before 2026-10.
        detect: /case\s*['"]UNFULFILLED['"]/,
        apply: (t) => {
          if (!/displayFulfillmentStatus|OrderDisplayFulfillmentStatus/.test(t)) return t;
          if (/FULFILLMENT_NOT_REQUIRED/.test(t)) return t;
          return t.replace(
            /^([ \t]*)case (['"])UNFULFILLED\2:/gm,
            (m, indent, q) => `${indent}case ${q}FULFILLMENT_NOT_REQUIRED${q}:\n${m}`,
          );
        },
      },
      {
        desc: 'Insert a FULFILLMENT_NOT_REQUIRED entry mirroring the UNFULFILLED entry in status-to-value object maps',
        // Same guards as above. The new key reuses the UNFULFILLED value
        // expression so labels/badges/priorities stay consistent with the
        // pre-2026-10 behavior; teams can refine the copy afterwards.
        detect: /^[ \t]*['"]?UNFULFILLED['"]?\s*:/m,
        apply: (t) => {
          if (!/displayFulfillmentStatus|OrderDisplayFulfillmentStatus/.test(t)) return t;
          if (/FULFILLMENT_NOT_REQUIRED/.test(t)) return t;
          return t.replace(
            /^([ \t]*)(['"]?)UNFULFILLED\2(\s*:\s*)(.*?),?[ \t]*$/gm,
            (m, indent, q, colon, val) => `${indent}${q}FULFILLMENT_NOT_REQUIRED${q}${colon}${val},\n${m}`,
          );
        },
      },
    ],
  },
  'twilio-verify-attempts-summary-servicesid': {
    provider: 'twilio',
    title: 'Twilio Verify: Attempts Summary query param ServiceSid -> VerifyServiceSid',
    reference: 'https://github.com/twilio/twilio-oai (twilio_verify_v2.json, 1.30.0 -> 1.40.0)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #3455 is the spec-diff-detected rename of the ServiceSid query
    // parameter to VerifyServiceSid on GET /v2/Attempts/Summary (verified
    // against both raw spec versions). First pack born from the spec-diff
    // pipeline: detection and mend share the same API-surface anchor.
    covers: [3455],
    rules: [
      {
        desc: 'Rename ServiceSid -> VerifyServiceSid on lines that build the Attempts/Summary request (query strings and param objects)',
        // Conservative guards: the rename only applies to the Attempts
        // Summary endpoint — ServiceSid remains valid as a path parameter on
        // /v2/Services/{ServiceSid} and elsewhere. So the rewrite is
        // line-scoped: only lines that themselves mention Attempts/Summary
        // are touched. Multi-line URLSearchParams construction is left to the
        // AST track (regex cannot safely bind a params object to its URL).
        detect: /Attempts\/Summary/,
        apply: (t) => t.split('\n').map((line) => {
          if (!/Attempts\/Summary/.test(line)) return line;
          return line.replace(/(?<![\w$])ServiceSid(?![\w$])/g, 'VerifyServiceSid');
        }).join('\n'),
      },
      {
        desc: 'Rename serviceSid -> verifyServiceSid inside verificationAttemptsSummary fetch-call options (twilio-node SDK surface)',
        // The twilio-node SDK exposes this endpoint as
        // client.verify.v2.verificationAttemptsSummary and a fetch call; the
        // option key follows the query param rename. Scoped to the option
        // object of that exact call chain so serviceSid options on other
        // Verify resources (services(), verifications, ...) are untouched.
        detect: /verificationAttemptsSummary/,
        apply: (t) => t.replace(
          /(verificationAttemptsSummary\s*(?:\(\s*\))?\s*\.fetch\s*\(\s*\{[^}]*?)(?<![\w$])serviceSid(?![\w$])(\s*:)/g,
          (_m, head, colon) => `${head}verifyServiceSid${colon}`,
        ),
      },
    ],
  },
  'twilio-messaging-brand-registration-a2p-casing': {
    provider: 'twilio',
    title: 'Twilio Messaging: BrandRegistrations form param A2pProfileBundleSid -> A2PProfileBundleSid',
    reference: 'https://github.com/twilio/twilio-oai (twilio_messaging_v1.json, 1.20.0 -> 1.30.0)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #3769/#3770 are the paired removed/added-required
    // records for the casing rename of the POST /v1/a2p/BrandRegistrations
    // request property (verified against both raw spec versions). twilio-node
    // has sent the correctly-cased form value since 3.56.0, so only raw REST
    // integrations that build the form body themselves are affected.
    covers: [3769, 3770],
    rules: [
      {
        desc: 'Rename the A2pProfileBundleSid form/query token to A2PProfileBundleSid in raw BrandRegistrations requests',
        // Conservative guards: only rewrite files that clearly talk to the
        // a2p/BrandRegistrations endpoint. The exact-case legacy token is
        // specific enough to rewrite file-wide once that anchor is present:
        // the SDK-side camelCase names (a2pProfileBundleSid response
        // attribute, a2PProfileBundleSid request option) are different
        // strings and stay untouched. Naturally idempotent — the legacy
        // token no longer exists after the rewrite.
        detect: /(?<![\w$])A2pProfileBundleSid(?![\w$])/,
        apply: (t) => {
          if (!/a2p\/BrandRegistrations/.test(t)) return t;
          return t.replace(/(?<![\w$])A2pProfileBundleSid(?![\w$])/g, 'A2PProfileBundleSid');
        },
      },
    ],
  },
  'twilio-linkshortening-messagingservicesids-removal': {
    provider: 'twilio',
    title: 'Twilio Messaging: LinkShortening domain config no longer accepts MessagingServiceSids / MessagingServiceSidsAction',
    reference: 'https://github.com/twilio/twilio-oai (twilio_messaging_v1.json, 1.40.0 -> 1.49.0)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #3869/#3870 record the removal of both request
    // properties from POST /v1/LinkShortening/Domains/{DomainSid}/Config
    // (verified against both raw spec versions; the messaging-service
    // association moved to dedicated LinkShortening endpoints). The mend
    // deletes the dead properties from call sites so requests stop sending
    // parameters the API no longer accepts. twilio-node main dropped the
    // matching update options, so both raw REST and SDK surfaces are mended.
    covers: [3869, 3870],
    rules: [
      {
        desc: 'Delete MessagingServiceSids / MessagingServiceSidsAction form fields and body properties from raw LinkShortening domain-config requests',
        // Conservative guards: only rewrite files that clearly talk to the
        // LinkShortening Domains surface. Two removal shapes, both
        // whole-line: structured form builders (set/append with the exact
        // property name) and single-line object properties in a request
        // body literal. Multi-line values and query-string concatenation are
        // left to the AST track (a regex cannot safely excise a segment from
        // a hand-built query string).
        detect: /MessagingServiceSids/,
        apply: (t) => {
          if (!/LinkShortening\/Domains/.test(t)) return t;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          return t.split('\n').filter((line) => {
            // form.set('MessagingServiceSids', ...) / form.append(...) lines
            if (/^[ \t]*[\w$.]+\.(?:set|append)\(\s*['"]MessagingServiceSids(?:Action)?['"]/.test(line) && balanced(line)) return false;
            // single-line body/object properties (arrays with commas included);
            // lines with unbalanced brackets open a multi-line value — leave
            // those to the AST track rather than break syntax.
            if (/^[ \t]*['"]?MessagingServiceSids(?:Action)?['"]?\s*:/.test(line) && balanced(line)) return false;
            return true;
          }).join('\n');
        },
      },
      {
        desc: 'Delete messagingServiceSids / messagingServiceSidsAction options from twilio-node domainConfig(...).update({...}) calls',
        // Scoped to the option object of the exact domainConfig update call
        // chain, so messagingServiceSids-shaped options on unrelated builders
        // stay untouched. Values are single-line (arrays without braces are
        // fine); multi-line values are left to the AST track.
        detect: /domainConfig/,
        apply: (t) => t.replace(
          /domainConfig\s*\([^)]*\)\s*\.update\s*\(\s*\{[^}]*\}/g,
          (block) => block.split('\n').filter((line) => {
            if (!/^[ \t]*messagingServiceSids(?:Action)?\s*:/.test(line)) return true;
            // only drop single-line values (balanced brackets on the line)
            for (const [o, c] of [['(', ')'], ['[', ']']]) {
              if (line.split(o).length !== line.split(c).length) return true;
            }
            return false;
          }).join('\n'),
        ),
      },
    ],
  },
  'paypal-server-sdk-v1-controller-renames': {
    provider: 'paypal',
    title: 'PayPal Server SDK 1.0.0: controller methods renamed (ordersCreate -> createOrder family)',
    reference: 'https://github.com/paypal/PayPal-TypeScript-Server-SDK/compare/0.6.1...1.0.0',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #627 is the 1.0.0 release of @paypal/paypal-server-sdk. The
    // full 15-pair rename map was verified token-by-token against the SDK
    // source (src/controllers) at tags 0.6.1 (old names) and 1.0.0 (new
    // names); method signatures stayed positional throughout. Note: the
    // rename actually landed in 0.7.0 and 1.0.0 kept it — this pack mends
    // any pre-0.7.0 call sites regardless of which release the user jumps to.
    covers: [627],
    // Revalidation stamp: #625 (2.0.0, 2025-11-06) audited when this pack was
    // built — doc/controllers were diffed across 1.0.0 and 2.0.0; the 2.0.0
    // options-object migration is handled by the sibling
    // paypal-server-sdk-v2-options-object pack. Renamed method names persist.
    revalidatedThrough: '2025-11-06',
    // No `chains` metadata, deliberately: the rewrite rules anchor on the
    // *variable names* `ordersController.` / `paymentsController.`
    // (controllers are constructed via `new OrdersController(client)`, they
    // are not chains off the SDK client), so a client-chain join cannot
    // mirror the fixer's anchoring. Instead the pack declares `controllers`:
    // ctor + anchor variable + the exact legacy method names the rules
    // rewrite. `mendapi deps --match` joins these against controller-call
    // surfaces (ctor-verified instance variables) — a hit means the fix
    // really touches that line, keeping the non-heuristic join semantics.
    controllers: [
      {
        ctor: 'OrdersController', anchor: 'ordersController',
        methods: ['ordersCreate', 'ordersGet', 'ordersPatch', 'ordersConfirm', 'ordersAuthorize', 'ordersCapture', 'ordersTrackCreate', 'ordersTrackersPatch'],
      },
      {
        ctor: 'PaymentsController', anchor: 'paymentsController',
        methods: ['authorizationsGet', 'authorizationsCapture', 'authorizationsReauthorize', 'authorizationsVoid', 'capturesGet', 'capturesRefund', 'refundsGet'],
      },
    ],
    rules: [
      {
        desc: 'ordersController: rename legacy method calls to their 1.0.0 names',
        // Conservative guard: only rewrite calls anchored on an
        // `ordersController.` member chain, so same-named methods on
        // unrelated objects are never touched. Whitelisted map only.
        detect: /ordersController\s*\.\s*orders[A-Z]/,
        apply: (t) => {
          const map = {
            ordersCreate: 'createOrder',
            ordersGet: 'getOrder',
            ordersPatch: 'patchOrder',
            ordersConfirm: 'confirmOrder',
            ordersAuthorize: 'authorizeOrder',
            ordersCapture: 'captureOrder',
            ordersTrackCreate: 'createOrderTracking',
            ordersTrackersPatch: 'updateOrderTracking',
          };
          return t.replace(
            /(ordersController\s*\.\s*)(ordersCreate|ordersGet|ordersPatch|ordersConfirm|ordersAuthorize|ordersCapture|ordersTrackCreate|ordersTrackersPatch)\b/g,
            (_m, chain, method) => `${chain}${map[method]}`,
          );
        },
      },
      {
        desc: 'paymentsController: rename legacy method calls to their 1.0.0 names',
        detect: /paymentsController\s*\.\s*(?:authorizations|captures|refunds)[A-Z]?/,
        apply: (t) => {
          const map = {
            authorizationsGet: 'getAuthorizedPayment',
            authorizationsCapture: 'captureAuthorizedPayment',
            authorizationsReauthorize: 'reauthorizePayment',
            authorizationsVoid: 'voidPayment',
            capturesGet: 'getCapturedPayment',
            capturesRefund: 'refundCapturedPayment',
            refundsGet: 'getRefund',
          };
          return t.replace(
            /(paymentsController\s*\.\s*)(authorizationsGet|authorizationsCapture|authorizationsReauthorize|authorizationsVoid|capturesGet|capturesRefund|refundsGet)\b/g,
            (_m, chain, method) => `${chain}${map[method]}`,
          );
        },
      },
    ],
  },
  'paypal-server-sdk-v2-options-object': {
    provider: 'paypal',
    title: 'PayPal Server SDK 2.0.0: controller methods switched from positional parameters to a single options object',
    reference: 'https://github.com/paypal/PayPal-TypeScript-Server-SDK (doc/controllers/orders.md + payments.md diffed between tags 1.0.0 and 2.0.0)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #625 is the 2.0.0 release. Verified against the official
    // controller docs at both tags: every method kept its name but wraps all
    // former positional parameters into a single destructured options object;
    // requestOptions stays behind as a second positional parameter. The
    // per-method parameter order below was extracted mechanically from the
    // 1.0.0 signatures, so the position-to-key mapping is deterministic.
    // Scope: single-line call sites only. Argument lists are split with a
    // string-aware bracket-depth scanner (not a naive comma split), so nested
    // calls, object literals, and string literals containing commas are safe.
    // Multi-line call sites are left to the AST track — the rule simply does
    // not match them, which is the conservative direction.
    covers: [625],
    // No `controllers` metadata, deliberately: unlike the 1.0.0 rename pack
    // (whose legacy method names disappear after migration, so a method-name
    // join is self-limiting), 2.0.0 keeps every method name and only changes
    // the argument shape. A ctor/anchor/method join cannot see argument
    // shapes, so it would also claim already-migrated call sites where this
    // pack is a no-op — a false "fix will touch this line". Accuracy law:
    // prefer a miss over a false claim.
    rules: [
      {
        desc: 'Wrap positional controller-method arguments into the 2.0.0 options object (requestOptions stays positional)',
        detect: /(?:orders|payments)Controller\s*\.\s*\w+\s*\(/,
        apply: (t) => {
          // Guard precedent from the 1.0.0 rename pack: the whitelisted
          // `ordersController.` / `paymentsController.` member-chain anchor
          // is the guard — same-named methods on unrelated objects are
          // never touched because they lack the controller chain.
          // Positional parameter order per method at 1.0.0 (last entry is
          // always requestOptions, which 2.0.0 keeps as a second positional
          // argument rather than an options-object key).
          const SIGS = {
            ordersController: {
              createOrder: ['body', 'paypalMockResponse', 'paypalRequestId', 'paypalPartnerAttributionId', 'paypalClientMetadataId', 'prefer', 'paypalAuthAssertion'],
              getOrder: ['id', 'paypalMockResponse', 'paypalAuthAssertion', 'fields'],
              patchOrder: ['id', 'paypalMockResponse', 'paypalAuthAssertion', 'body'],
              confirmOrder: ['id', 'paypalClientMetadataId', 'paypalAuthAssertion', 'prefer', 'body'],
              authorizeOrder: ['id', 'paypalMockResponse', 'paypalRequestId', 'prefer', 'paypalClientMetadataId', 'paypalAuthAssertion', 'body'],
              captureOrder: ['id', 'paypalMockResponse', 'paypalRequestId', 'prefer', 'paypalClientMetadataId', 'paypalAuthAssertion', 'body'],
              createOrderTracking: ['id', 'body', 'paypalAuthAssertion'],
              updateOrderTracking: ['id', 'trackerId', 'paypalAuthAssertion', 'body'],
            },
            paymentsController: {
              getAuthorizedPayment: ['authorizationId', 'paypalMockResponse', 'paypalAuthAssertion'],
              captureAuthorizedPayment: ['authorizationId', 'paypalMockResponse', 'paypalRequestId', 'prefer', 'paypalAuthAssertion', 'body'],
              reauthorizePayment: ['authorizationId', 'paypalRequestId', 'prefer', 'paypalAuthAssertion', 'body'],
              voidPayment: ['authorizationId', 'paypalMockResponse', 'paypalAuthAssertion', 'paypalRequestId', 'prefer'],
              getCapturedPayment: ['captureId', 'paypalMockResponse'],
              refundCapturedPayment: ['captureId', 'paypalMockResponse', 'paypalRequestId', 'prefer', 'paypalAuthAssertion', 'body'],
              getRefund: ['refundId', 'paypalMockResponse', 'paypalAuthAssertion'],
            },
          };
          // String-aware bracket-depth argument splitter. Returns null when
          // the argument list does not close on the same line (multi-line
          // call sites go to the AST track) or contains template literals /
          // comments we cannot reason about safely.
          const splitArgs = (s, from) => {
            let depth = 1;
            const args = [];
            let cur = '';
            let i = from;
            while (i < s.length) {
              const ch = s[i];
              if (ch === '\n') return null;
              if (ch === "'" || ch === '"') {
                const q = ch;
                cur += ch;
                i++;
                while (i < s.length && s[i] !== q) {
                  if (s[i] === '\\') { cur += s[i]; i++; }
                  if (i < s.length) { cur += s[i]; i++; }
                }
                if (i >= s.length) return null;
                cur += q;
                i++;
                continue;
              }
              if (ch === '`' || (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*'))) return null;
              if (ch === '(' || ch === '[' || ch === '{') depth++;
              else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth === 0) return { args: cur.trim() ? [...args, cur.trim()] : args, end: i };
              }
              if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; }
              else cur += ch;
              i++;
            }
            return null;
          };
          const callRe = /\b(ordersController|paymentsController)\s*\.\s*(\w+)\s*\(/g;
          let out = '';
          let last = 0;
          let m;
          while ((m = callRe.exec(t)) !== null) {
            const params = SIGS[m[1]] && SIGS[m[1]][m[2]];
            if (!params) continue;
            const open = m.index + m[0].length;
            const parsed = splitArgs(t, open);
            if (!parsed) continue;
            const { args, end } = parsed;
            // Already migrated (first argument is an object literal) or
            // empty call: leave untouched — natural idempotency.
            if (args.length === 0 || args[0].startsWith('{')) continue;
            // More args than positional slots (+1 for requestOptions):
            // signature mismatch, do not guess.
            if (args.length > params.length + 1) continue;
            const requestOptions = args.length === params.length + 1 ? args[params.length] : null;
            const pairs = [];
            for (let k = 0; k < Math.min(args.length, params.length); k++) {
              if (args[k] === 'undefined' || args[k] === 'null') continue;
              pairs.push(args[k] === params[k] ? params[k] : `${params[k]}: ${args[k]}`);
            }
            const optsObj = `{ ${pairs.join(', ')} }`;
            const rebuilt = requestOptions && requestOptions !== 'undefined'
              ? `${optsObj}, ${requestOptions}`
              : optsObj;
            out += t.slice(last, open) + rebuilt;
            last = end;
            callRe.lastIndex = end;
          }
          out += t.slice(last);
          return out;
        },
      },
    ],
  },
  'paypal-orders-v2-swish-pix-payment-source-removal': {
    provider: 'paypal',
    title: 'PayPal Orders v2: the swish and pix payment sources removed entirely (2026-04 spec)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/checkout_orders_v2.json @ a54ed770ae vs @ 9f0f52810a: payment_source/payment_source_response lose swish and pix; schemas swish/swish_request/experience_context_swish/pix/pix_request deleted)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep removal of the swish
    // (100 records) and pix (210 records) payment-source branches from
    // every Orders v2 request/response surface (create/get/confirm/
    // authorize/capture x branch subtree). Verified against cached spec
    // snapshots: pix token count 6 -> 0; the two surviving swish tokens
    // are dangling {"required":["swish"]} oneOf branches with no backing
    // property. The payment_source object itself stays fully functional
    // for every other method, so the mend deletes the swish/pix branch
    // (request writes, response reads, destructured names) and leaves
    // the rest of the integration untouched. Choosing a replacement
    // payment method for affected buyers is a business decision the
    // migration guide calls out — no substitution is attempted.
    covers: [51196, 51197, 51198, 51199, 51200, 51201, 51202, 51203, 51204, 51205, 51206, 51207, 51208, 51209, 51210, 51211, 51212, 51213, 51214, 51215, 51216, 51222, 51223, 51224, 51225, 51226, 51227, 51228, 51229, 51230, 51231, 51232, 51233, 51234, 51235, 51236, 51237, 51238, 51239, 51240, 51241, 51242, 51243, 51244, 51245, 51246, 51248, 51249, 51250, 51251, 51252, 51253, 51254, 51255, 51256, 51257, 51258, 51259, 51260, 51261, 51262, 51263, 51264, 51265, 51266, 51267, 51268, 51271, 51272, 51273, 51274, 51275, 51276, 51277, 51278, 51279, 51280, 51281, 51282, 51283, 51284, 51285, 51286, 51287, 51288, 51289, 51290, 51291, 51294, 51295, 51296, 51297, 51298, 51299, 51300, 51301, 51302, 51303, 51304, 51305, 51306, 51307, 51308, 51309, 51310, 51311, 51312, 51313, 51314, 51315, 51316, 51317, 51318, 51320, 51321, 51322, 51323, 51324, 51325, 51326, 51327, 51328, 51329, 51330, 51331, 51332, 51333, 51334, 51335, 51336, 51337, 51338, 51339, 51340, 51343, 51344, 51345, 51346, 51347, 51348, 51349, 51350, 51351, 51352, 51353, 51354, 51355, 51356, 51357, 51358, 51359, 51360, 51361, 51362, 51363, 51366, 51367, 51368, 51369, 51370, 51371, 51372, 51373, 51374, 51375, 51376, 51377, 51378, 51379, 51380, 51381, 51382, 51383, 51384, 51385, 51386, 51387, 51388, 51389, 51390, 51392, 51393, 51394, 51395, 51396, 51397, 51398, 51399, 51400, 51401, 51402, 51403, 51404, 51405, 51406, 51407, 51408, 51409, 51410, 51411, 51412, 51415, 51416, 51417, 51418, 51419, 51420, 51421, 51422, 51423, 51424, 51425, 51426, 51427, 51428, 51429, 51430, 51431, 51432, 51433, 51434, 51435, 51441, 51442, 51443, 51444, 51445, 51446, 51447, 51448, 51449, 51450, 51451, 51452, 51453, 51454, 51455, 51456, 51457, 51458, 51459, 51460, 51461, 51462, 51463, 51464, 51465, 51468, 51469, 51470, 51471, 51472, 51473, 51474, 51475, 51476, 51477, 51478, 51479, 51480, 51481, 51482, 51483, 51484, 51485, 51486, 51487, 51488, 51491, 51492, 51493, 51494, 51495, 51496, 51497, 51498, 51499, 51500, 51501, 51502, 51503, 51504, 51505, 51506, 51507, 51508, 51509, 51510, 51511, 51514, 51515, 51516, 51517, 51518, 51519, 51520, 51521, 51522, 51523, 51524, 51525, 51526, 51527, 51528, 51529, 51530, 51531, 51532, 51533, 51534],
    rules: [
      {
        desc: 'Remove swish/pix payment-source branches (request payloads, response reads, destructuring) from PayPal Orders v2 consumers; sibling payment sources are preserved',
        // Conservative guards: the file must clearly talk to the PayPal
        // Orders API AND mention payment_source before anything is
        // rewritten. Because pix is a short generic token, every
        // rewritten line must additionally anchor to the payment-source
        // surface: a member chain through payment_source, a
        // payment_source-scoped destructuring, or a single-line branch
        // block carrying the source-specific request keys. Unrelated
        // objects that happen to use a pix/swish key never match.
        // Multi-line branch blocks (unbalanced lines), bare case labels
        // and binding declarations are left to the AST track.
        detect: /\b(?:swish|pix)\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/checkout\/orders\b/.test(t) || /\bpaypal\b/i.test(t);
          if (!paypalCtx || !/\bpayment_source\b/.test(t)) return t;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const sourceAnchored = (line) =>
            /\bpayment_source\b/.test(line) ||
            /\b(?:swish|pix)\s*:\s*\{[^{}\n]*\b(?:country_code|experience_context|tax_info|email_address|qr_data|qr_details)\b/.test(line);
          return t.split('\n').map((line) => {
            if (!/\b(?:swish|pix)\b/.test(line)) return line;
            if (!sourceAnchored(line)) return line; // not the payment-source surface
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines are not code surfaces
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // destructuring off the payment_source object: drop the branch name, keep siblings
            let out = line.replace(/\{([^{}]*\b(?:swish|pix)\b[^{}]*)\}\s*=\s*([^;]*\bpayment_source\b[^;]*);/g, (m, names, src) => {
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'swish' && n !== 'pix');
              return `{ ${list.join(', ')} } = ${src.trim()};`;
            });
            // single-line branch block property: drop the entry, keep siblings
            out = out
              .replace(/\b(?:swish|pix)\s*:\s*\{[^{}\n]*\}\s*,\s*/g, '')
              .replace(/,\s*(?:swish|pix)\s*:\s*\{[^{}\n]*\}/g, '')
              .replace(/\{\s*(?:swish|pix)\s*:\s*\{[^{}\n]*\}\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // A payment_source write whose branch block could not be
            // removed above (nested braces inside the branch value) may
            // carry sibling sources on the same line — deleting the whole
            // line would drop them. Left to the AST track.
            if (/\bpayment_source\s*:\s*\{/.test(line)) return line;
            // Binding declarations (const x = ...payment_source.swish...)
            // are never dropped: downstream references to the binding
            // would become ReferenceErrors. Left to the AST track.
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced payment_source-anchored lines referencing
            // the removed branch are dead reads/writes
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced swish/pix bindings from flat payment_source destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone (multi-line patterns fail the balanced-line
        // gate; single-line payment_source patterns it already rewrites).
        // pix is a short generic token (imaging presets, print densities),
        // so each field carries an anchor gate on top of the primitive's
        // guards: EVERY flat destructuring pattern in the file that binds
        // the name must have a right-hand side anchored to a member chain
        // ending at payment_source (the negative lookahead rejects deeper
        // chains - the withdrawn branches live directly on the object). One
        // unanchored pattern (a `pix` pulled off an in-house print preset
        // row, say) and the field is skipped for the whole file. Patterns
        // that pass the gate go through removeDestructuredProperty, which
        // only removes a binding when it is flat, default/rest-free and has
        // zero other code-region references (member access and
        // string/comment mentions never count).
        detect: /\{[^{}]*\b(?:swish|pix)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/checkout\/orders\b/.test(t) || /\bpaypal\b/i.test(t);
          if (!paypalCtx || !/\bpayment_source\b/.test(t)) return t;
          const ANCHOR = /\.\s*payment_source\b(?!\s*\??\.)/;
          let out = t;
          for (const field of ['swish', 'pix']) {
            const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
            let sawPattern = false;
            let allAnchored = true;
            for (const m of out.matchAll(pat)) {
              sawPattern = true;
              if (!ANCHOR.test(m[1])) { allAnchored = false; break; }
            }
            if (!sawPattern || !allAnchored) continue;
            out = removeDestructuredProperty(out, field);
          }
          return out;
        },
      },
    ],
  },
  'paypal-vault-v3-wallet-profile-fields-removal': {
    provider: 'paypal',
    title: 'PayPal Vault v3: paypal/venmo wallet responses drop extended profile fields (birth_date, tax_info, extended name and address fields)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/vault_payment_tokens_v3.json @ fb6f12627e vs @ a54ed770ae: paypal/venmo wallet response schemas lose birth_date, tax_info(.tax_id/.tax_id_type), name.{prefix,middle_name,suffix,full_name,alternate_full_name} and address.{address_line_3,admin_area_3,admin_area_4,address_details})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep data-minimisation
    // contraction of the paypal and venmo wallet profile surfaces across
    // every Vault v3 payment-token read (GET list, GET/POST token,
    // setup-token surfaces). Verified against cached spec snapshots: the
    // surviving name object is exactly { given_name, surname } and the
    // surviving address object is exactly the six core fields
    // (address_line_1, address_line_2, admin_area_1, admin_area_2,
    // postal_code, country_code). The removed fields have no successor
    // and values from other surfaces are not semantically
    // interchangeable, so the mend deletes reads of the withdrawn
    // fields; surviving-field reads are never touched.
    covers: [56612, 56613, 56614, 56615, 56621, 56622, 56623, 56624, 56625, 56626, 56627, 56628, 56629, 56630, 56631, 56632, 56633, 56634, 56635, 56636, 56637, 56638, 56639, 56640, 56641, 56642, 56643, 56644, 56645, 56646, 56660, 56661, 56662, 56663, 56664, 56665, 56666, 56667, 56668, 56669, 56670, 56671, 56672, 56673, 56674, 56675, 56676, 56677, 56678, 56679, 56680, 56681, 56682, 56683, 56684, 56685, 56709, 56710, 56711, 56712, 56713, 56714, 56715, 56716, 56717, 56718, 56719, 56720, 56721, 56722, 56723, 56724, 56725, 56726, 56727, 56728, 56729, 56730, 56731, 56732, 56733, 56734, 56743, 56744, 56745, 56746, 56747, 56748, 56749, 56750, 56751, 56752, 56753, 56754, 56755, 56756, 56757, 56758, 56759, 56760, 56761, 56762, 56763, 56764, 56765, 56766, 56767, 56768, 56798, 56799, 56800, 56801, 56802, 56803, 56804, 56805, 56806, 56807, 56808, 56809, 56810, 56811, 56812, 56813, 56814, 56815, 56816, 56817, 56818, 56819, 56820, 56821, 56822, 56823, 56825, 56826, 56827, 56828, 56829, 56830, 56831, 56832, 56833, 56834, 56835, 56836, 56837, 56838, 56839, 56840, 56841, 56842, 56843, 56844, 56845, 56846, 56847, 56848, 56849, 56850],
    rules: [
      {
        desc: 'Remove reads of withdrawn paypal/venmo wallet profile fields (birth_date, tax_info, extended name/address fields) on PayPal Vault v3 payment-token surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the vault/payment-token surface before
        // anything is rewritten. Every rewritten line must anchor to a
        // .paypal./.venmo. member chain ending in a withdrawn field
        // path — surviving fields (given_name, surname, the six core
        // address fields, phone_number, email_address) never match, and
        // generic tokens such as birth_date on unrelated objects never
        // match without the wallet-branch chain. Lines with unbalanced
        // brackets (multi-line values), bare case labels, destructuring
        // and binding declarations are left to the AST track.
        detect: /\.\s*(?:paypal|venmo)\s*\??\.\s*(?:birth_date|tax_info|name\s*\??\.|address\s*\??\.)/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          const CHAIN = /\.\s*(?:paypal|venmo)\s*\??\.\s*(?:birth_date\b|tax_info\b(?:\s*\??\.\s*(?:tax_id_type|tax_id)\b)?|name\s*\??\.\s*(?:prefix|middle_name|suffix|full_name|alternate_full_name)\b|address\s*\??\.\s*(?:address_line_3|admin_area_3|admin_area_4|address_details)\b)/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*(?:paypal|venmo)\s*\??\.\s*(?:birth_date\b|tax_info\b(?:\s*\??\.\s*(?:tax_id_type|tax_id)\b)?|name\s*\??\.\s*(?:prefix|middle_name|suffix|full_name|alternate_full_name)\b|address\s*\??\.\s*(?:address_line_3|admin_area_3|admin_area_4|address_details)\b)`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads a withdrawn
            // field: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading a withdrawn field are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-field bindings from flat paypal/venmo wallet destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The withdrawn names live at three depths of
        // the wallet object (top-level birth_date/tax_info, name.* extended
        // fields, address.* extended fields), so each group carries its own
        // anchor gate on top of the primitive's guards: for each field,
        // EVERY flat destructuring pattern in the file that binds the name
        // must have a right-hand side anchored to that group's paypal/venmo
        // member chain — one unanchored pattern (a `birth_date` pulled off
        // an HR record, say) and the field is skipped for the whole file.
        // Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count).
        detect: /\{[^{}]*\b(?:birth_date|tax_info|prefix|middle_name|suffix|full_name|alternate_full_name|address_line_3|admin_area_3|admin_area_4|address_details|tax_id_type|tax_id)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          const GROUPS = [
            // chain must end at .paypal / .venmo (the wallet object itself)
            { fields: ['birth_date', 'tax_info'], anchor: /\.\s*(?:paypal|venmo)\b(?!\s*\??\.)/ },
            { fields: ['prefix', 'middle_name', 'suffix', 'full_name', 'alternate_full_name'], anchor: /\.\s*(?:paypal|venmo)\s*\??\.\s*name\b/ },
            { fields: ['address_line_3', 'admin_area_3', 'admin_area_4', 'address_details'], anchor: /\.\s*(?:paypal|venmo)\s*\??\.\s*address\b/ },
            { fields: ['tax_id', 'tax_id_type'], anchor: /\.\s*(?:paypal|venmo)\s*\??\.\s*tax_info\b/ },
          ];
          let out = t;
          for (const { fields, anchor } of GROUPS) {
            for (const field of fields) {
              const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
              let sawPattern = false;
              let allAnchored = true;
              for (const m of out.matchAll(pat)) {
                sawPattern = true;
                if (!anchor.test(m[1])) { allAnchored = false; break; }
              }
              if (!sawPattern || !allAnchored) continue;
              out = removeDestructuredProperty(out, field);
            }
          }
          return out;
        },
      },
    ],
  },
  'paypal-vault-v3-apple-pay-card-fields-removal': {
    provider: 'paypal',
    title: 'PayPal Vault v3: apple_pay card responses drop PAN-adjacent fields (id, number, expiry, security_code, card_type)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/vault_payment_tokens_v3.json @ fb6f12627e vs @ a54ed770ae: apple_pay card contracts from the full card schema (10 properties) to a display-safe subset — name, last_digits, type, brand, billing_address survive; id, number, expiry, security_code, card_type are withdrawn)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep contraction of the
    // apple_pay.card response object across the Vault v3 payment-token
    // read surfaces (GET token 200, POST token 200/201). Verified
    // against cached spec snapshots: the old apple_pay_card schema
    // resolved (via allOf -> card) to 10 properties; the new inline
    // Apple Pay Card object keeps exactly { name, last_digits, type,
    // brand, billing_address }. The removed fields are PAN-adjacent
    // data with no successor (last_digits + brand are the surviving
    // display identifiers), so the mend deletes reads of the withdrawn
    // fields; surviving-field reads are never touched.
    covers: [56647, 56648, 56649, 56650, 56651, 56735, 56736, 56737, 56738, 56739, 56769, 56770, 56771, 56772, 56773],
    rules: [
      {
        desc: 'Remove reads of withdrawn apple_pay.card fields (id, number, expiry, security_code, card_type) on PayPal Vault v3 payment-token surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the vault/payment-token surface before
        // anything is rewritten. Every rewritten line must anchor to an
        // .apple_pay.card. member chain ending in a withdrawn field —
        // surviving fields (name, last_digits, type, brand,
        // billing_address) never match, and generic tokens such as id
        // or number on unrelated objects never match without the
        // apple_pay.card chain. Note card_type is matched with a word
        // boundary so the surviving .type read is untouched. Lines with
        // unbalanced brackets (multi-line values), bare case labels,
        // destructuring and binding declarations are left to the AST
        // track (same verdicts as the wallet-profile pack).
        detect: /\.\s*apple_pay\s*\??\.\s*card\s*\??\.\s*(?:id|number|expiry|security_code|card_type)\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          const CHAIN = /\.\s*apple_pay\s*\??\.\s*card\s*\??\.\s*(?:id|number|expiry|security_code|card_type)\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*apple_pay\s*\??\.\s*card\s*\??\.\s*(?:id|number|expiry|security_code|card_type)\b`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads a withdrawn
            // field: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading a withdrawn field are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-field bindings from flat apple_pay.card destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The five withdrawn field names are generic
        // tokens (id and number especially), so this pass adds an anchor
        // gate on top of the primitive's own guards: for each field, EVERY
        // flat destructuring pattern in the file that binds the name must
        // have a right-hand side anchored to the apple_pay.card member
        // chain — one unanchored pattern (an `id` pulled off an in-house
        // registry row, say) and the field is skipped for the whole file.
        // Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count).
        detect: /\{[^{}]*\b(?:id|number|expiry|security_code|card_type)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          let out = t;
          for (const field of ['id', 'number', 'expiry', 'security_code', 'card_type']) {
            const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
            const anchor = /apple_pay\s*\??\.\s*card\b/;
            let sawPattern = false;
            let allAnchored = true;
            for (const m of out.matchAll(pat)) {
              sawPattern = true;
              if (!anchor.test(m[1])) { allAnchored = false; break; }
            }
            if (!sawPattern || !allAnchored) continue;
            out = removeDestructuredProperty(out, field);
          }
          return out;
        },
      },
    ],
  },
  'paypal-vault-v3-information-link-error-field-removal': {
    provider: 'paypal',
    title: 'PayPal Vault v3: error bodies drop the legacy information_link HATEOAS field',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/vault_payment_tokens_v3.json @ fb6f12627e vs @ a54ed770aec6: the shared error schema loses information_link across every 4xx/5xx response on the payment-token and setup-token surfaces; new error bodies are {name, message, details, debug_id, links})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep removal of the
    // legacy information_link property from the shared error schema on
    // the Vault v3 payment-token/setup-token error responses. Verified
    // against cached spec snapshots: old error schema properties were
    // {name, message, debug_id, information_link, details, links};
    // every new error_4xx/error_500/error_503 schema is {name, message,
    // details?, debug_id, links} — no successor property (the remaining
    // information_link tokens in the new spec are static examples inside
    // error_503, not properties). The mend deletes reads of
    // information_link; the links array (HATEOAS) or debug_id are the
    // documented support-correlation alternatives and reads of them are
    // never touched.
    covers: [56609, 56610, 56611, 56618, 56619, 56620, 56655, 56656, 56657, 56658, 56686, 56687, 56688, 56689, 56777, 56778, 56779, 56780, 56781, 56851, 56852, 56853, 56854],
    rules: [
      {
        desc: 'Remove reads of the withdrawn information_link error-body field on PayPal Vault v3 payment-token surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the vault/payment-token surface before
        // anything is rewritten. Every rewritten line must anchor to an
        // .information_link member read (including ?. forms) — the token
        // is distinctive, but the double file-level guard still keeps
        // unrelated codebases (internal doc registries etc.) untouched.
        // Surviving error fields (name, message, debug_id, details,
        // links) never match. Lines with unbalanced brackets
        // (multi-line values), bare case labels, destructuring and
        // binding declarations are left to the AST track (same verdicts
        // as the wallet-profile pack).
        detect: /\.\s*information_link\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          const CHAIN = /\??\.\s*information_link\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\??\.\s*information_link\b`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads the withdrawn
            // field: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading the withdrawn field are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced information_link bindings from flat error-body destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. information_link is a distinctive token
        // (same reasoning as the line-level rule), so no anchor gate is
        // layered on top: the double file-level guard plus the primitive's
        // own conservative judgements (flat patterns only, no defaults/rest,
        // zero other code-region references for the bound identifier) carry
        // the safety story - `const { information_link, links } = body;
        // return { information_link, links };` survives untouched while a
        // genuinely dead binding loses only the withdrawn field.
        detect: /\{[^{}]*\binformation_link\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v3\/vault\b/.test(t) || /\bpaypal\b/i.test(t);
          const vaultCtx = /\/v3\/vault|payment[_-]?tokens|paymentTokens|setup[_-]?tokens|setupTokens/i.test(t);
          if (!paypalCtx || !vaultCtx) return t;
          return removeDestructuredProperty(t, 'information_link');
        },
      },
    ],
  },
  'paypal-billing-subscriptions-v1-subscriber-address-removal': {
    provider: 'paypal',
    title: 'PayPal Subscriptions v1: subscriber responses drop the address object entirely (all fields and address_details subpaths)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/billing_subscriptions_v1.json @ fb6f12627e vs @ 7bbed782: the resolved subscriber and subscriber_request schemas lose the address key entirely — NEW props are {email_address, name, payer_id, payment_source, phone, shipping_address}; billing addresses live on payment_source.card.billing_address, delivery addresses on subscriber.shipping_address.address)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep removal of the
    // subscriber.address object (and every subfield including the
    // address_details subtree) from the Subscriptions v1 read surfaces
    // (GET /v1/billing/subscriptions/{id} and POST /v1/billing/
    // subscriptions 200/201 echoes). Verified against cached spec
    // snapshots with allOf resolution: OLD subscriber props included
    // address (portable_postal_address_medium_grained, 10 fields plus
    // address_details); NEW subscriber and subscriber_request carry no
    // address key at all. There is no same-shape successor — the
    // documented alternatives are payment_source.card.billing_address
    // (billing) and subscriber.shipping_address.address (delivery,
    // six core fields) — so the mend deletes reads of the withdrawn
    // object; shipping_address.address reads anchor to a different
    // member chain and are never touched.
    covers: [57284, 57285, 57286, 57287, 57288, 57289, 57290, 57291, 57292, 57293, 57294, 57295, 57296, 57297, 57298, 57299, 57300, 57333, 57334, 57335, 57336, 57337, 57338, 57339, 57340, 57341, 57342, 57343, 57344, 57345, 57346, 57347, 57348, 57349, 57376, 57377, 57378, 57379, 57380, 57381, 57382, 57383, 57384, 57385, 57386, 57387, 57388, 57389, 57390, 57391, 57392, 57422, 57423, 57424, 57425, 57426, 57427, 57428, 57429, 57430, 57431, 57432, 57433, 57434, 57435, 57436, 57437, 57438],
    rules: [
      {
        desc: 'Remove reads of the withdrawn subscriber.address object on PayPal Subscriptions v1 surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the billing-subscriptions surface before
        // anything is rewritten. Every rewritten line must anchor to a
        // .subscriber.address member chain (including ?. forms) — the
        // surviving shipping_address.address reads sit on a different
        // chain (.subscriber.shipping_address.address) and never match,
        // and generic subscriber.address tokens in unrelated codebases
        // (mailing lists etc.) never fire without the double file-level
        // guard. Lines with unbalanced brackets (multi-line values),
        // bare case labels, destructuring and binding declarations are
        // left to the AST track (same verdicts as the wallet-profile
        // pack).
        detect: /\.\s*subscriber\s*\??\.\s*address\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          const CHAIN = /\.\s*subscriber\s*\??\.\s*address\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*subscriber\s*\??\.\s*address\b`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads the withdrawn
            // object: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading the withdrawn object are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn address bindings from flat subscriber destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. `address` is as generic as identifiers get
        // (CRM records, shipping surfaces, form models all bind it), so the
        // pack layers an anchor gate on top of the primitive's guards:
        // EVERY flat destructuring pattern in the file that binds `address`
        // must have a right-hand side anchored to a member chain ending at
        // .subscriber (the negative lookahead rejects deeper chains such as
        // .subscriber.shipping_address, whose address object survives the
        // contraction) - one unanchored pattern and the whole file is
        // skipped. Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count).
        detect: /\{[^{}]*\baddress\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          // chain must end at .subscriber (the subscriber object itself);
          // .subscriber.shipping_address and any deeper chain never pass
          const ANCHOR = /\.\s*subscriber\b(?!\s*\??\.)/;
          const pat = /\{[^{}]*\baddress\b[^{}]*\}\s*=\s*([^;\n]*)/g;
          let sawPattern = false;
          let allAnchored = true;
          for (const m of t.matchAll(pat)) {
            sawPattern = true;
            if (!ANCHOR.test(m[1])) { allAnchored = false; break; }
          }
          if (!sawPattern || !allAnchored) return t;
          return removeDestructuredProperty(t, 'address');
        },
      },
    ],
  },
  'paypal-billing-subscriptions-v1-shipping-address-trim': {
    provider: 'paypal',
    title: 'PayPal Subscriptions v1: subscriber.shipping_address name and address objects trimmed to core fields (name keeps full_name only; address loses line_3, admin_area_3/4 and the address_details subtree)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/billing_subscriptions_v1.json @ fb6f12627e vs @ 7bbed782: resolved shipping_address.name props shrink from {prefix, given_name, surname, middle_name, suffix, full_name, alternate_full_name} to {full_name}; shipping_address.address props shrink from ten fields plus the address_details subtree to the six core fields {address_line_1, address_line_2, admin_area_1, admin_area_2, postal_code, country_code})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep trim of the
    // Subscriptions v1 shipping_address read surfaces. Verified against
    // cached spec snapshots with allOf resolution: NEW name carries only
    // full_name (note this is the OPPOSITE direction of subscriber.name,
    // which kept given_name/surname), and NEW address carries only the
    // six core portable-address fields. There is no same-shape successor
    // for the withdrawn fields, so the mend deletes reads of them;
    // surviving fields (full_name, address_line_1/2, admin_area_1/2,
    // postal_code, country_code) anchor to different leaf tokens and are
    // never touched.
    covers: [57301, 57302, 57303, 57304, 57305, 57306, 57307, 57308, 57309, 57310, 57350, 57351, 57352, 57353, 57354, 57355, 57356, 57357, 57358, 57359, 57393, 57394, 57395, 57396, 57397, 57398, 57399, 57400, 57401, 57402, 57439, 57440, 57441, 57442, 57443, 57444, 57445, 57446, 57447, 57448, 57460, 57461, 57462, 57463, 57464, 57465, 57466, 57467, 57468, 57469, 57470, 57471, 57472, 57473, 57474, 57475, 57479, 57480, 57481, 57482, 57483, 57484, 57485, 57486, 57487, 57488, 57489, 57490, 57491, 57492, 57493, 57494],
    rules: [
      {
        desc: 'Remove reads of withdrawn shipping_address.name and shipping_address.address fields on PayPal Subscriptions v1 surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the billing-subscriptions surface before
        // anything is rewritten. Every rewritten line must anchor to a
        // .shipping_address.name.<withdrawn> or
        // .shipping_address.address.<withdrawn> member chain (including
        // ?. forms) - surviving leaves (full_name, address_line_1/2,
        // admin_area_1/2, postal_code, country_code) never match, and
        // generic shipping_address tokens in unrelated codebases never
        // fire without the double file-level guard. Lines with
        // unbalanced brackets (multi-line values), bare case labels,
        // destructuring and binding declarations are left to the AST
        // track (same verdicts as the wallet-profile pack).
        detect: /\.\s*shipping_address\s*\??\.\s*(?:name\s*\??\.\s*(?:prefix|given_name|surname|middle_name|suffix|alternate_full_name)|address\s*\??\.\s*(?:address_line_3|admin_area_3|admin_area_4|address_details))\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          const CHAIN = /\.\s*shipping_address\s*\??\.\s*(?:name\s*\??\.\s*(?:prefix|given_name|surname|middle_name|suffix|alternate_full_name)|address\s*\??\.\s*(?:address_line_3|admin_area_3|admin_area_4|address_details))\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*shipping_address\s*\??\.\s*(?:name\s*\??\.\s*(?:prefix|given_name|surname|middle_name|suffix|alternate_full_name)|address\s*\??\.\s*(?:address_line_3|admin_area_3|admin_area_4|address_details))\b`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads a withdrawn
            // field: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading withdrawn fields are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-field bindings from flat shipping_address destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The withdrawn names live at two depths of
        // the shipping_address object (name.* extended fields, address.*
        // extended fields) and several of them survive elsewhere on the
        // very same response (given_name/surname stay on subscriber.name),
        // so each group carries its own anchor gate on top of the
        // primitive's guards: for each field, EVERY flat destructuring
        // pattern in the file that binds the name must have a right-hand
        // side anchored to that group's shipping_address member chain -
        // one unanchored pattern (a `prefix` pulled off the surviving
        // subscriber.name, say) and the field is skipped for the whole
        // file. Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count).
        detect: /\{[^{}]*\b(?:prefix|given_name|surname|middle_name|suffix|alternate_full_name|address_line_3|admin_area_3|admin_area_4|address_details)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          const GROUPS = [
            { fields: ['prefix', 'given_name', 'surname', 'middle_name', 'suffix', 'alternate_full_name'], anchor: /\.\s*shipping_address\s*\??\.\s*name\b/ },
            { fields: ['address_line_3', 'admin_area_3', 'admin_area_4', 'address_details'], anchor: /\.\s*shipping_address\s*\??\.\s*address\b/ },
          ];
          let out = t;
          for (const { fields, anchor } of GROUPS) {
            for (const field of fields) {
              const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
              let sawPattern = false;
              let allAnchored = true;
              for (const m of out.matchAll(pat)) {
                sawPattern = true;
                if (!anchor.test(m[1])) { allAnchored = false; break; }
              }
              if (!sawPattern || !allAnchored) continue;
              out = removeDestructuredProperty(out, field);
            }
          }
          return out;
        },
      },
    ],
  },
  'paypal-billing-subscriptions-v1-subscriber-pii-removal': {
    provider: 'paypal',
    title: 'PayPal Subscriptions v1: subscriber request and response surfaces drop the PII fields birth_date and tax_info (including tax_id and tax_id_type)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/billing_subscriptions_v1.json @ fb6f12627e vs @ 7bbed782: the resolved subscriber and subscriber_request schemas lose birth_date and the whole tax_info object {tax_id, tax_id_type} — NEW props are {email_address, name, payer_id, payment_source, phone, shipping_address})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep PII data-minimisation
    // removal of subscriber.birth_date and subscriber.tax_info (with its
    // tax_id / tax_id_type subfields) from both the request (POST /v1/
    // billing/subscriptions) and response (GET subscription, POST
    // 200/201 echoes) surfaces. Verified against cached spec snapshots
    // with allOf resolution: OLD subscriber and subscriber_request both
    // carried birth_date and tax_info; NEW carries neither key. There
    // is no successor field (same contraction the Vault v3 wallet
    // profile pack records for paypal/venmo wallets), so the mend
    // deletes reads and writes of the withdrawn fields; surviving
    // sibling fields (email_address, name, phone, payer_id,
    // shipping_address) anchor to different leaf tokens and are never
    // touched.
    covers: [57280, 57281, 57282, 57283, 57329, 57330, 57331, 57332, 57372, 57373, 57374, 57375, 57418, 57419, 57420, 57421],
    rules: [
      {
        desc: 'Remove reads of the withdrawn subscriber.birth_date and subscriber.tax_info PII fields on PayPal Subscriptions v1 surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the billing-subscriptions surface before
        // anything is rewritten. Every rewritten line must anchor to a
        // .subscriber.birth_date or .subscriber.tax_info member chain
        // (including ?. forms) — generic birth_date / tax_info tokens on
        // unrelated objects (HR records, KYC profiles) never fire
        // without the subscriber chain plus the double file-level
        // guard. Lines with unbalanced brackets (multi-line values),
        // bare case labels, destructuring and binding declarations are
        // left to the AST track (same verdicts as the wallet-profile
        // pack).
        detect: /\.\s*subscriber\s*\??\.\s*(?:birth_date|tax_info)\b/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          const CHAIN = /\.\s*subscriber\s*\??\.\s*(?:birth_date\b|tax_info\b(?:\s*\??\.\s*(?:tax_id_type|tax_id)\b)?)/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*subscriber\s*\??\.\s*(?:birth_date\b|tax_info\b(?:\s*\??\.\s*(?:tax_id_type|tax_id)\b)?)`;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // single-line object property whose value reads a withdrawn
            // field: drop the entry, keep siblings
            let out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading withdrawn fields are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-field bindings from flat subscriber PII destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The withdrawn names live at two depths of
        // the subscriber object (top-level birth_date/tax_info, tax_id and
        // tax_id_type under tax_info), so each group carries its own anchor
        // gate on top of the primitive's guards: for each field, EVERY flat
        // destructuring pattern in the file that binds the name must have a
        // right-hand side anchored to that group's subscriber member chain
        // - one unanchored pattern (a `birth_date` pulled off an HR record,
        // say) and the field is skipped for the whole file. Patterns that
        // pass the gate go through removeDestructuredProperty, which only
        // removes a binding when it is flat, default/rest-free and has zero
        // other code-region references (member access and string/comment
        // mentions never count).
        detect: /\{[^{}]*\b(?:birth_date|tax_info|tax_id_type|tax_id)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v1\/billing\b/.test(t) || /\bpaypal\b/i.test(t);
          const subsCtx = /\/v1\/billing\/subscriptions|billing[_-]?subscriptions|billingSubscriptions/i.test(t);
          if (!paypalCtx || !subsCtx) return t;
          const GROUPS = [
            // chain must end at .subscriber (the subscriber object itself)
            { fields: ['birth_date', 'tax_info'], anchor: /\.\s*subscriber\b(?!\s*\??\.)/ },
            { fields: ['tax_id', 'tax_id_type'], anchor: /\.\s*subscriber\s*\??\.\s*tax_info\b/ },
          ];
          let out = t;
          for (const { fields, anchor } of GROUPS) {
            for (const field of fields) {
              const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
              let sawPattern = false;
              let allAnchored = true;
              for (const m of out.matchAll(pat)) {
                sawPattern = true;
                if (!anchor.test(m[1])) { allAnchored = false; break; }
              }
              if (!sawPattern || !allAnchored) continue;
              out = removeDestructuredProperty(out, field);
            }
          }
          return out;
        },
      },
    ],
  },
  'paypal-partner-referrals-v2-office-bearers-removal': {
    provider: 'paypal',
    title: 'PayPal Partner Referrals v2: the whole business_entity.office_bearers subtree is removed from request and response surfaces (the office_bearer schema itself is gone)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/customer_partner_referrals_v2.json @ fb6f12627e vs @ 7bbed782: the office_bearer and office_bearer_role schemas exist in OLD and are absent from NEW; resolved business_entity props lose the office_bearers key while the sibling beneficial_owners list survives in both versions)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep removal of the
    // business_entity.office_bearers subtree (officer identity: names,
    // citizenship, addresses, phones, birth_details, documents, role)
    // from both POST /v2/customer/partner-referrals request payloads and
    // the GET referral 200 response. Verified against cached spec
    // snapshots: the office_bearer / office_bearer_role schemas are gone
    // from NEW entirely and the only remaining office_bearers token is a
    // static response example, not a property. There is no successor
    // field - the sibling beneficial_owners list survives but models
    // ownership, not officers, so substituting it is a business decision
    // and this pack never does it. The mend deletes writes and reads of
    // the withdrawn subtree; surviving siblings (names, beneficial_owners,
    // documents, phones on business_entity itself) anchor to a different
    // leaf token and are never touched.
    covers: [58051, 58052, 58053, 58054, 58055, 58056, 58057, 58058, 58059, 58077, 58078, 58079, 58080, 58081, 58082, 58083, 58084, 58085, 58086, 58087, 58088, 58089, 58090, 58091, 58092, 58093, 58094, 58095, 58096, 58097, 58098, 58099, 58100, 58101, 58102, 58103, 58104, 58105, 58106, 58107, 58108, 58109, 58110, 58111, 58112, 58113, 58114, 58115, 58116, 58117, 58118, 58119, 58120, 58121, 58122, 58123, 58124, 58125],
    rules: [
      {
        desc: 'Remove writes and reads of the withdrawn business_entity.office_bearers subtree on PayPal Partner Referrals v2 surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the partner-referrals surface before anything
        // is rewritten. Every rewritten line must anchor to a
        // .business_entity.office_bearers member chain (including ?.
        // forms) - generic office_bearers tokens on unrelated objects
        // (HR org charts, registries) never fire without the chain plus
        // the double file-level guard. Lines with unbalanced brackets
        // (multi-line values), bare case labels, destructuring and
        // binding declarations are left to the AST track (same verdicts
        // as the subscriber packs).
        detect: /\.\s*business_entity\s*\??\.\s*office_bearers\b|\boffice_bearers\s*:/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/customer\b/.test(t) || /\bpaypal\b/i.test(t);
          const prCtx = /\/v2\/customer\/partner-referrals|partner[_-]?referrals|partnerReferrals/i.test(t);
          if (!paypalCtx || !prCtx) return t;
          const CHAIN = /\.\s*business_entity\s*\??\.\s*office_bearers\b/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const FIELD = String.raw`\.\s*business_entity\s*\??\.\s*office_bearers\b(?:[\w$\[\]\.\?\s]*)?`;
          // Object-literal writes carry the bare key (office_bearers:)
          // without the chain prefix; the token is highly distinctive and
          // the double file-level guard is already satisfied, so bare-key
          // write lines are eligible too (errlink pack precedent for
          // distinctive-token line gates).
          const WRITE_KEY = /\boffice_bearers\s*:/;
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line) && !WRITE_KEY.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // Object-literal WRITE of the withdrawn subtree
            // (office_bearers: <expr>) on a single balanced line: drop
            // the entry, keep siblings.
            let out = line
              .replace(/\boffice_bearers\s*:\s*[^,{}\n]*\s*,\s*/g, '')
              .replace(/,\s*\boffice_bearers\s*:\s*[^,{}\n]*/g, '')
              .replace(/\{\s*office_bearers\s*:\s*[^,{}\n]*\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // single-line object property whose value READS the withdrawn
            // subtree: drop the entry, keep siblings
            out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading the withdrawn subtree are
            // dead reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced office_bearers bindings from flat business_entity destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. office_bearers is distinctive but not
        // unique (HR org charts and civic registries bind it too), so the
        // pack layers an anchor gate on top of the primitive's guards:
        // EVERY flat destructuring pattern in the file that binds
        // office_bearers must have a right-hand side anchored to a member
        // chain ending at .business_entity (the negative lookahead rejects
        // deeper chains - the subtree has no surviving same-name deeper
        // surface, but the gate stays consistent with the subscriber
        // packs) - one unanchored pattern and the whole file is skipped.
        // Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count).
        detect: /\{[^{}]*\boffice_bearers\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/customer\b/.test(t) || /\bpaypal\b/i.test(t);
          const prCtx = /\/v2\/customer\/partner-referrals|partner[_-]?referrals|partnerReferrals/i.test(t);
          if (!paypalCtx || !prCtx) return t;
          // chain must end at .business_entity (the owning object itself)
          const ANCHOR = /\.\s*business_entity\b(?!\s*\??\.)/;
          const pat = /\{[^{}]*\boffice_bearers\b[^{}]*\}\s*=\s*([^;\n]*)/g;
          let sawPattern = false;
          let allAnchored = true;
          for (const m of t.matchAll(pat)) {
            sawPattern = true;
            if (!ANCHOR.test(m[1])) { allAnchored = false; break; }
          }
          if (!sawPattern || !allAnchored) return t;
          return removeDestructuredProperty(t, 'office_bearers');
        },
      },
    ],
  },
  'paypal-partner-referrals-v2-contact-detail-trim': {
    provider: 'paypal',
    title: 'PayPal Partner Referrals v2: phone and address detail schemas trimmed to core fields (phones lose contact_name, inactive, primary, primary_mobile and tags; addresses lose the primary and inactive flags)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/customer_partner_referrals_v2.json @ fb6f12627e vs @ 7bbed782: resolved person_phone_detail props shrink from {contact_name, country_code, extension_number, inactive, national_number, primary, primary_mobile, tags, type} to {country_code, extension_number, national_number, type}; business_phone_detail loses the same leaves (it never had primary_mobile); person_address_detail and business_address_detail both lose the primary and inactive boolean flags while all eleven positional address leaves survive - the primary and inactive tokens go 4 -> 0 spec-wide)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep trim of the phone and
    // address detail schemas on both POST /v2/customer/partner-referrals
    // request payloads and the GET referral 200 response (individual_owners
    // and business_entity projections; the office_bearers projections of
    // the same trim are covered by the office-bearers-removal pack because
    // that whole subtree is gone). Verified against cached spec snapshots
    // with allOf resolution. There is no successor field for any withdrawn
    // leaf - the surviving phone identity (country_code, national_number,
    // extension_number, type) and the eleven positional address leaves are
    // unchanged, anchor to different leaf tokens and are never touched.
    covers: [58036, 58037, 58038, 58039, 58040, 58041, 58042, 58045, 58046, 58047, 58048, 58049, 58050, 58062, 58063, 58064, 58065, 58066, 58067, 58068, 58071, 58072, 58073, 58074, 58075, 58076],
    rules: [
      {
        desc: 'Remove reads and writes of withdrawn phones[] and addresses[] metadata leaves on PayPal Partner Referrals v2 surfaces',
        // Conservative guards: the file must clearly talk to the PayPal
        // API AND mention the partner-referrals surface before anything
        // is rewritten. Every rewritten read line must anchor to a
        // .phones[...].<withdrawn> or .addresses[...].<withdrawn> member
        // chain (including ?. and ?.[i] forms) - surviving leaves
        // (country_code, national_number, extension_number, type,
        // address_line_*, admin_area_*, postal_code) never match, and
        // the generic tokens (primary, inactive, tags) on unrelated
        // objects never fire without the array-element chain plus the
        // double file-level guard. Object-literal WRITE lines are only
        // eaten for the two distinctive keys (contact_name:,
        // primary_mobile: - errlink/office-bearers distinctive-token
        // precedent); the generic keys primary:/inactive:/tags: inside
        // payload literals are left to the AST track (cannot be safely
        // distinguished from unrelated literals on a line gate). Lines
        // with unbalanced brackets, bare case labels, destructuring and
        // binding declarations are left to the AST track (same verdicts
        // as the subscriber packs).
        detect: /\.\s*(?:phones|addresses)\s*\??\.?\s*\[[^\]]*\]\s*\??\.\s*(?:contact_name|primary_mobile|primary|inactive|tags)\b|\b(?:contact_name|primary_mobile)\s*:/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/customer\b/.test(t) || /\bpaypal\b/i.test(t);
          const prCtx = /\/v2\/customer\/partner-referrals|partner[_-]?referrals|partnerReferrals/i.test(t);
          if (!paypalCtx || !prCtx) return t;
          const FIELD = String.raw`\.\s*(?:phones|addresses)\s*\??\.?\s*\[[^\]]*\]\s*\??\.\s*(?:contact_name|primary_mobile|primary|inactive|tags)\b`;
          const CHAIN = new RegExp(FIELD);
          const WRITE_KEY = /\b(?:contact_name|primary_mobile)\s*:/;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          return t.split('\n').map((line) => {
            if (!CHAIN.test(line) && !WRITE_KEY.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            if (!balanced(line)) return line; // multi-line value: AST track
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // Destructuring is left untouched: dropped bindings degrade to
            // undefined rather than breaking (AST track for full cleanup).
            if (/\{[^{}]*\}\s*=/.test(line)) return line;
            // Object-literal WRITE of a distinctive withdrawn key
            // (contact_name: <expr> / primary_mobile: <expr>) on a single
            // balanced line: drop the entry, keep siblings.
            let out = line
              .replace(/\b(?:contact_name|primary_mobile)\s*:\s*[^,{}\n]*\s*,\s*/g, '')
              .replace(/,\s*\b(?:contact_name|primary_mobile)\s*:\s*[^,{}\n]*/g, '')
              .replace(/\{\s*(?:contact_name|primary_mobile)\s*:\s*[^,{}\n]*\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // single-line object property whose value READS a withdrawn
            // leaf via the array-element chain: drop the entry, keep
            // siblings
            out = line
              .replace(new RegExp(String.raw`\b[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*,\s*`, 'g'), '')
              .replace(new RegExp(String.raw`,\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*`, 'g'), '')
              .replace(new RegExp(String.raw`\{\s*[\w$]+\s*:\s*[^,{}\n]*` + FIELD + String.raw`[^,}\n]*\s*\}`, 'g'), '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            if (!CHAIN.test(line)) return line; // write-key line that did not rewrite: leave
            // Binding declarations are never dropped (ReferenceError risk).
            if (/^[ \t]*(?:const|let|var)\s+[\w$]+\s*=/.test(line)) return line;
            // remaining balanced lines reading withdrawn leaves are dead
            // reads (assignments, conditionals, display statements)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
      {
        desc: 'Remove unreferenced withdrawn-leaf bindings from flat phones[]/addresses[] destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone. The withdrawn leaves are generic tokens
        // (primary/inactive especially - any in-house record schema binds
        // them), so each group carries its own anchor gate on top of the
        // primitive's guards: for each field, EVERY flat destructuring
        // pattern in the file that binds the name must have a right-hand
        // side anchored to a member chain ending at a phones[...] /
        // addresses[...] array element (the negative lookahead rejects
        // deeper chains - the withdrawn leaves live directly on the
        // element). contact_name/primary_mobile/tags are phone-only
        // leaves; primary/inactive were withdrawn from both detail
        // schemas, so either element chain anchors them. One unanchored
        // pattern (a `primary` pulled off an in-house seating row, say)
        // and the field is skipped for the whole file. Patterns that pass
        // the gate go through removeDestructuredProperty, which only
        // removes a binding when it is flat, default/rest-free and has
        // zero other code-region references (member access and
        // string/comment mentions never count).
        detect: /\{[^{}]*\b(?:contact_name|primary_mobile|tags|primary|inactive)\b[^{}]*\}\s*=/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/customer\b/.test(t) || /\bpaypal\b/i.test(t);
          const prCtx = /\/v2\/customer\/partner-referrals|partner[_-]?referrals|partnerReferrals/i.test(t);
          if (!paypalCtx || !prCtx) return t;
          const GROUPS = [
            { fields: ['contact_name', 'primary_mobile', 'tags'], anchor: /\.\s*phones\s*\??\.?\s*\[[^\]]*\](?!\s*\??\.)/ },
            { fields: ['primary', 'inactive'], anchor: /\.\s*(?:phones|addresses)\s*\??\.?\s*\[[^\]]*\](?!\s*\??\.)/ },
          ];
          let out = t;
          for (const { fields, anchor } of GROUPS) {
            for (const field of fields) {
              const pat = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=\\s*([^;\\n]*)`, 'g');
              let sawPattern = false;
              let allAnchored = true;
              for (const m of out.matchAll(pat)) {
                sawPattern = true;
                if (!anchor.test(m[1])) { allAnchored = false; break; }
              }
              if (!sawPattern || !allAnchored) continue;
              out = removeDestructuredProperty(out, field);
            }
          }
          return out;
        },
      },
    ],
  },
  'paypal-invoicing-v2-error-link-method-enum-shrink': {
    provider: 'paypal',
    title: 'PayPal Invoicing v2: error-body HATEOAS links[].method enum drops CONNECT, HEAD and OPTIONS (navigation links keep the full verb set)',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/invoicing_v2.json @ fb6f12627e vs @ 7bbed782: the shared error_link_description schema shrinks its method enum from [CONNECT, DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT] to [GET, POST, PUT, DELETE, PATCH]; the sibling link_description schema keeps the full 8-value enum in both versions, so the shrink is scoped to links read from ERROR response bodies only)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes below record the one-sweep enum contraction of
    // error_link_description.method across every Invoicing v2 operation
    // and error status (77 op-by-status faces, three withdrawn verbs).
    // Verified against cached spec snapshots, token-level: the withdrawn
    // verbs CONNECT/HEAD/OPTIONS were never navigable anyway, and the
    // non-error link_description schema documents the full verb set in
    // BOTH versions - dispatch on navigation links is untouched. The mend
    // deletes single-line error-handler guards that dispatch exclusively
    // on the withdrawn verbs; the anchor requires an error-flavoured
    // receiver (err*/error*/fault* .links[...] chains or errLink-style
    // variables) so generic HTTP routing code (req.method === 'HEAD') and
    // navigation-link dispatch never match. Mixed conditions (withdrawn
    // plus surviving verbs), negated filters, loop variables detached
    // from an error receiver, case labels, destructuring and binding
    // declarations are all left to the AST track - miss, never mangle.
    covers: [57603, 57604, 57605, 57606, 57607, 57608, 57609, 57610, 57611, 57612, 57613, 57614, 57615, 57616, 57617, 57618, 57619, 57620, 57621, 57622, 57623, 57624, 57625, 57626, 57627, 57628, 57629, 57630, 57631, 57632, 57633, 57634, 57635, 57636, 57637, 57638, 57639, 57640, 57641, 57642, 57643, 57644, 57645, 57646, 57647, 57648, 57649, 57650, 57651, 57652, 57653, 57654, 57655, 57656, 57657, 57658, 57659, 57660, 57661, 57662, 57663, 57664, 57665, 57666, 57667, 57668, 57669, 57670, 57671, 57672, 57673, 57674, 57675, 57676, 57677, 57678, 57679, 57680, 57681, 57682, 57683, 57684, 57685, 57686, 57687, 57688, 57689, 57690, 57691, 57692, 57693, 57694, 57695, 57696, 57697, 57698, 57699, 57700, 57701, 57702, 57703, 57704, 57705, 57706, 57707, 57708, 57709, 57710, 57711, 57712, 57713, 57714, 57715, 57716, 57717, 57718, 57719, 57720, 57721, 57722, 57723, 57724, 57725, 57726, 57727, 57728, 57729, 57730, 57731, 57732, 57733, 57734, 57735, 57736, 57737, 57738, 57739, 57740, 57741, 57742, 57743, 57744, 57745, 57746, 57747, 57748, 57749, 57750, 57751, 57752, 57753, 57754, 57755, 57756, 57757, 57758, 57759, 57760, 57761, 57762, 57763, 57764, 57765, 57766, 57767, 57768, 57769, 57770, 57771, 57772, 57773, 57778, 57779, 57780, 57781, 57782, 57783, 57784, 57785, 57786, 57787, 57788, 57789, 57790, 57791, 57792, 57793, 57794, 57795, 57796, 57797, 57798, 57799, 57800, 57801, 57802, 57803, 57804, 57805, 57806, 57807, 57808, 57809, 57810, 57811, 57812, 57813, 57814, 57815, 57816, 57817, 57818, 57819, 57820, 57821, 57822, 57823, 57824, 57825, 57826, 57827, 57828, 57829, 57830, 57831, 57832, 57833, 57834, 57835, 57836, 57837],
    rules: [
      {
        desc: 'Delete error-handler guards dispatching solely on the withdrawn CONNECT/HEAD/OPTIONS error-link method values on PayPal Invoicing v2 surfaces',
        detect: /\.\s*method\s*={2,3}\s*['"](?:CONNECT|HEAD|OPTIONS)['"]/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/invoicing\b/.test(t) || /\bpaypal\b/i.test(t);
          const invCtx = /\/v2\/invoicing|invoicing/i.test(t);
          if (!paypalCtx || !invCtx) return t;
          // Error-flavoured receivers only: err.links[i].method,
          // error.links[0]?.method, fault.links[j].method, or an
          // errLink/errorLink-style variable. Plain link/l/nav receivers
          // never match (navigation links keep the full enum).
          const ANCHOR = String.raw`(?:\b(?:err|error|fault)[\w$]*\s*\??\.\s*links\s*\[[^\]]*\]\s*\??|\b(?:err|error|fault)[\w$]*[Ll]ink[\w$]*\s*\??)\.\s*method\b`;
          const CMP = new RegExp(String.raw`^\s*` + ANCHOR + String.raw`\s*={2,3}\s*['"](?:CONNECT|HEAD|OPTIONS)['"]\s*$`);
          const IF_GUARD = /^[ \t]*if\s*\((.*)\)\s*(?:\{\s*)?(?:continue|break|return\b[^;{}]*)\s*;?\s*(?:\})?\s*$/;
          return t.split('\n').map((line) => {
            if (!/={2,3}\s*['"](?:CONNECT|HEAD|OPTIONS)['"]/.test(line)) return line;
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            const m = line.match(IF_GUARD);
            if (!m) return line; // only self-contained single-line guards are safe to delete
            // The whole condition must be a ||-disjunction of anchored
            // equality comparisons against the withdrawn verbs. Anything
            // else (surviving verbs, negations, mixed clauses, unanchored
            // receivers) leaves the line untouched.
            const parts = m[1].split('||');
            if (!parts.length || !parts.every((p) => CMP.test(p))) return line;
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
    ],
  },
  'paypal-invoicing-v2-send-202-body-unwrap': {
    provider: 'paypal',
    title: 'PayPal Invoicing v2: send-invoice 202 body reshaped from {links: [link, ...]} wrapper to a single link object {href, rel, method}',
    reference: 'https://github.com/paypal/paypal-rest-api-specifications (openapi/invoicing_v2.json @ fb6f12627e vs @ 7bbed782: POST /v2/invoicing/invoices/{invoice_id}/send 202 content referenced #/components/schemas/202-response whose ONLY property was links (array of link_description); the new spec references link_description directly, resolved props {href, rel, method})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // the four spec-diff changes below are the projection of one reshape:
    // the send-invoice 202 wrapper object was replaced by the single link
    // object it used to wrap. Verified against cached spec snapshots,
    // token-level: OLD 202 -> 202-response {links}; NEW 202 ->
    // link_description {href, rel, method}. The mend rewrites
    // <recv>.links[0].href/rel/method reads into <recv>.href/rel/method,
    // but ONLY for receivers this pack can prove came from the send call:
    // the receiver identifier must be bound on a single line from an
    // expression naming both the invoicing surface and send (e.g.
    // `const r = await client.post(\`/v2/invoicing/invoices/${id}/send\`)`
    // or `const r = await sendInvoice(id)`). Navigation-link reads on
    // other receivers (invoice.links[0].href), non-zero indexes,
    // .links.find(...) predicate scans, destructuring and cross-statement
    // dataflow are all left to the AST/LLM track - miss, never mangle.
    covers: [57774, 57775, 57776, 57777],
    rules: [
      {
        desc: 'Unwrap send-invoice 202 reads: <sendResult>.links[0].href/rel/method -> <sendResult>.href/rel/method',
        detect: /\.\s*links\s*(?:\?\.)?\s*\[\s*0\s*\]/,
        apply: (t) => {
          const paypalCtx = /api(?:-m)?\.(?:sandbox\.)?paypal\.com/.test(t) || /\/v2\/invoicing\b/.test(t) || /\bpaypal\b/i.test(t);
          const invCtx = /\/v2\/invoicing|invoic/i.test(t);
          if (!paypalCtx || !invCtx) return t;
          // Pass 1: collect identifiers bound (on one line) from a
          // send-invoice call. The binding line must name both an
          // invoicing token and send - anything less is not provably
          // the reshaped 202 body.
          const recvs = new Set();
          const BIND = /^[ \t]*(?:const|let|var)\s+([\w$]+)\s*=/;
          for (const line of t.split('\n')) {
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) continue;
            if (!/invoic/i.test(line) || !/send/i.test(line)) continue;
            const m = line.match(BIND);
            if (m) recvs.add(m[1]);
          }
          if (!recvs.size) return t;
          // Pass 2: rewrite index-0 link reads on proven receivers only.
          const names = [...recvs].map((n) => n.replace(/\$/g, '\\$')).join('|');
          const READ = new RegExp(
            String.raw`\b(${names})\s*(\??\.)\s*links\s*(?:\?\.)?\s*\[\s*0\s*\]\s*\??\.\s*(href|rel|method)\b`,
            'g',
          );
          return t.split('\n').map((line) => {
            if (/^[ \t]*(?:\/\/|\/?\*)/.test(line)) return line; // prose/comment lines
            return line.replace(READ, (_m, recv, dot, leaf) => `${recv}${dot}${leaf}`);
          }).join('\n');
        },
      },
    ],
  },
  'plaid-node-v43-v44-breaking-renames': {
    provider: 'plaid',
    title: 'Plaid Node 43.0.0/44.0.0: terminate reason-code type unification, interest-only literal, reports_requested array',
    reference: 'https://github.com/plaid/plaid-node/blob/master/CHANGELOG.md (43.0.0 and 44.0.0 breaking lists)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // change #42 (44.0.0) removed ItemProductsTerminateReasonCode and
    // UserProductsTerminateReasonCode in favor of ProductsTerminateReasonCode
    // (wire values unchanged) and changed the StudentRepaymentPlanType
    // interest-only literal to serialize with a space; change #43 (43.0.0)
    // replaced the scalar request field on /cra/check_report/verification/pdf/get
    // with a plural array field. All three mends were verified against the
    // official plaid-node CHANGELOG breaking lists.
    covers: [42, 43],
    // Revalidation stamp: #41 (45.0.0, 2026-07-24) audited — CRA report
    // TypeScript type widening only, wire format unchanged, no impact on the
    // renamed tokens this pack rewrites (fixability record + asset 41.json).
    revalidatedThrough: '2026-07-24',
    rules: [
      {
        desc: 'Unify Item/User products-terminate reason-code type names into ProductsTerminateReasonCode',
        // Conservative guard: only rewrite files that import the plaid SDK.
        // After the whole-file rename, destructured plaid import lists may
        // contain the unified name twice - those lists are deduplicated so
        // the rewrite never produces a duplicate binding. Naturally
        // idempotent: the legacy tokens no longer exist after the rewrite.
        detect: /\b(?:Item|User)ProductsTerminateReasonCode\b/,
        apply: (t) => {
          if (!/require\(['"]plaid['"]\)|from\s+['"]plaid['"]/.test(t)) return t;
          let out = t.replace(/\b(?:Item|User)ProductsTerminateReasonCode\b/g, 'ProductsTerminateReasonCode');
          // Deduplicate names inside plaid import/require destructuring lists.
          out = out.replace(
            /\{([^{}]*)\}(\s*=\s*require\(['"]plaid['"]\)|\s*from\s+['"]plaid['"])/g,
            (_m, names, tail) => {
              const seen = new Set();
              const list = names.split(',').map((n) => n.trim()).filter((n) => {
                if (!n || seen.has(n)) return false;
                seen.add(n);
                return true;
              });
              return `{ ${list.join(', ')} }${tail}`;
            },
          );
          return out;
        },
      },
      {
        desc: "Update StudentRepaymentPlanType raw string comparisons: hyphenated interest literal -> 'interest only'",
        // Conservative guards: the hyphenated literal is a generic English
        // phrase, so the rewrite requires BOTH a plaid SDK import AND a
        // student-repayment surface marker in the file. Non-plaid mortgage
        // code that happens to use the same phrase is never touched.
        detect: /(['"])interest-only\1/,
        apply: (t) => {
          if (!/require\(['"]plaid['"]\)|from\s+['"]plaid['"]/.test(t)) return t;
          if (!/StudentRepaymentPlanType|repayment_plan/.test(t)) return t;
          return t.replace(/(['"])interest-only\1/g, (_m, q) => `${q}interest only${q}`);
        },
      },
      {
        desc: 'craCheckReportVerificationPdfGet: rename report_requested -> reports_requested and wrap the scalar value in an array',
        // Scoped to the option object of that exact SDK call, so same-named
        // keys on unrelated objects are never touched. Only single-line
        // scalar values are wrapped; the key rename makes the rule naturally
        // idempotent (the legacy key no longer exists afterwards).
        detect: /craCheckReportVerificationPdfGet/,
        apply: (t) => t.replace(
          /(craCheckReportVerificationPdfGet\s*\(\s*\{[^}]*?)(['"]?)report_requested\2(\s*:\s*)([^,\n}]+?)(\s*[,}\n])/g,
          (_m, head, q, colon, value, tail) => `${head}${q}reports_requested${q}${colon}[${value.trim()}]${tail}`,
        ),
      },
    ],
  },
  'vercel-web-analytics-dhe-cipher-suite-removal': {
    provider: 'vercel',
    title: 'Vercel Web Analytics: dheCipherSuite response dimension discontinued (v1.28.9)',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.28.8 vs v1.28.9: /v1/query/web-analytics/* responses)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #5772-#5775 record the removal of the dheCipherSuite
    // TLS dimension from all four web-analytics query responses (events and
    // visits, aggregate and count). Verified against cached OAS snapshots:
    // present through v1.28.8 (10 occurrences), zero occurrences from
    // v1.28.9 with no successor field. The mend deletes the dead field read:
    // destructured bindings, group-by/dimension list entries, object
    // properties, and whole-line statements that only exist to consume the
    // dimension. There is no replacement data source.
    covers: [5772, 5773, 5774, 5775],
    rules: [
      {
        desc: 'Remove dheCipherSuite reads (destructuring, dimension lists, object properties, and consuming statements) from web-analytics query consumers',
        // Conservative guards: only rewrite files that clearly consume the
        // Vercel web-analytics query surface (the endpoint path or an
        // explicit web-analytics marker). Removal shapes are all
        // line-bounded; lines with unbalanced brackets (multi-line values)
        // are left to the AST track rather than break syntax.
        detect: /\bdheCipherSuite\b/,
        apply: (t) => {
          const webAnalytics = /query\/web-analytics/.test(t) || /web[\s-]analytics/i.test(t);
          if (!webAnalytics) return t;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          let out = t
            // destructuring / inline object lists: drop the name, keep siblings.
            // Destructuring patterns (brace group followed by `=`) are left to
            // the AST-track rule below — it reference-counts the binding before
            // touching it, so a live `const { dheCipherSuite, x } = row` used
            // later is never mangled into a ReferenceError.
            .replace(/\{([^{}\n]*\bdheCipherSuite\b[^{}\n]*)\}/g, (m, names, offset, str) => {
              if (/^\s*=[^=]/.test(str.slice(offset + m.length))) return m; // destructuring: AST track
              // only prune plain identifier lists (no nested values with colons
              // other than simple `key: value` — handled by the line rules below)
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'dheCipherSuite');
              return `{ ${list.join(', ')} }`;
            })
            // string entries in dimension/group-by arrays: 'dheCipherSuite',
            .replace(/(['"])dheCipherSuite\1\s*,\s*/g, '')
            .replace(/,\s*(['"])dheCipherSuite\1/g, '');
          // whole-line removals: object properties keyed on the dimension and
          // standalone statements that consume it (grouping, display, sums).
          out = out.split('\n').filter((line) => {
            if (!/\bdheCipherSuite\b/.test(line)) return true;
            if (!balanced(line)) return true; // multi-line value: AST track
            // destructuring patterns are left to the AST-track rule below:
            // single-line alias forms (`{ dheCipherSuite: cipher, browser }`)
            // and bare entry lines of multi-line patterns — deleting the whole
            // line would drop live sibling bindings.
            if (/\{[^{}]*\bdheCipherSuite\b[^{}]*\}\s*=/.test(line)) return true;
            if (/^[ \t]*dheCipherSuite\s*,?\s*$/.test(line)) return true;
            // object property line: `dheCipherSuite: <value>,`
            if (/^[ \t]*['"]?dheCipherSuite['"]?\s*:/.test(line)) return false;
            // statement line that only exists to consume the dead dimension
            if (/^[ \t]*[\w$[\].]*\bdheCipherSuite\b/.test(line) || /^[ \t]*(?:const|let|var)\b[^=]*=\s*[^;]*\bdheCipherSuite\b/.test(line)) return false;
            return false; // remaining balanced lines referencing the token are dead reads
          }).join('\n');
          return out;
        },
      },
      {
        desc: 'Remove unreferenced dheCipherSuite bindings from flat destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone (single-line alias forms and multi-line
        // patterns). Analytics query rows are plain objects, so the
        // right-hand side carries no member-chain anchor to gate on — the
        // file-level web-analytics marker is the scope guard, matching the
        // line-level rule. removeDestructuredProperty enforces its own
        // conservative guards: flat patterns only, no defaults/rest, and the
        // bound identifier must have zero other code-region references
        // (member access and string/comment mentions never count) — so
        // `const { dheCipherSuite: suite, country } = row; return { suite, country };`
        // survives untouched while a genuinely dead binding loses only the
        // withdrawn dimension.
        detect: /\{[^{}]*\bdheCipherSuite\b[^{}]*\}\s*=/,
        apply: (t) => {
          const webAnalytics = /query\/web-analytics/.test(t) || /web[\s-]analytics/i.test(t);
          if (!webAnalytics) return t;
          return removeDestructuredProperty(t, 'dheCipherSuite');
        },
      },
    ],
  },
  'vercel-project-extended-max-duration-removal': {
    provider: 'vercel',
    title: 'Vercel Projects: enableFunctionsExtendedMaxDuration flag withdrawn from the API surface (v1.28.0)',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.27.0 vs v1.28.0: project create/update resourceConfig, project responses, event types)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #6425/#6428/#6429/#6432/#6434-#6437/#6441/#6442/
    // #6445-#6447/#6450/#6451/#6458-#6460/#6463/#6464 record the one-sweep
    // withdrawal of the enableFunctionsExtendedMaxDuration flag: the token
    // appears 20 times in the v1.27.0 OAS and zero times from v1.28.0
    // onward, with no successor field. Request schemas use
    // additionalProperties:false, so keeping the flag in payloads is
    // rejected upstream. The event type
    // project-functions-extended-max-duration-updated no longer exists
    // either. The mend deletes the dead flag from request payloads,
    // removes reads of it from response handling, and removes single-line
    // consumers of the discontinued event type. Whether extended function
    // duration is still configurable is a platform-plan question outside
    // code reach.
    covers: [6425, 6428, 6429, 6432, 6434, 6435, 6436, 6437, 6441, 6442, 6445, 6446, 6447, 6450, 6451, 6458, 6459, 6460, 6463, 6464],
    rules: [
      {
        desc: 'Remove enableFunctionsExtendedMaxDuration payload flags and reads, plus single-line consumers of the discontinued project-functions-extended-max-duration-updated event type',
        // Conservative guards: only rewrite files that clearly talk to the
        // Vercel project API (api host, a versioned /projects path, or an
        // explicit vercel marker). Removal shapes are all line-bounded;
        // lines with unbalanced brackets (multi-line values) and bare
        // `case '<event>':` labels with multi-line bodies are left to the
        // AST track rather than break syntax or merge switch branches.
        detect: /enableFunctionsExtendedMaxDuration|project-functions-extended-max-duration-updated/,
        apply: (t) => {
          const vercelCtx = /api\.vercel\.com/.test(t) || /\/v\d+\/projects\b/.test(t) || /\bvercel\b/i.test(t);
          if (!vercelCtx) return t;
          const FLAG = 'enableFunctionsExtendedMaxDuration';
          const EVENT = 'project-functions-extended-max-duration-updated';
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          // string entries in event-type arrays are position-independent
          // and safe to strip on the full text: '<event>',
          let out = t
            .replace(/(['"])project-functions-extended-max-duration-updated\1\s*,\s*/g, '')
            .replace(/,\s*(['"])project-functions-extended-max-duration-updated\1/g, '');
          // everything else is line-scoped so destructuring patterns can be
          // recognised and left to the AST-track rule below - a full-text
          // property regex cannot tell an object-literal entry from a
          // destructuring alias (`{ flag: ext } = ...`) and would strip a
          // live binding into a ReferenceError.
          out = out.split('\n').map((line) => {
            const hasFlag = new RegExp(`\\b${FLAG}\\b`).test(line);
            const hasEvent = line.includes(EVENT);
            if (!hasFlag && !hasEvent) return line;
            if (!balanced(line)) return line; // multi-line value: AST track
            // destructuring patterns (plain, aliased, single- or multi-line
            // entry lines) are left to the AST-track rule below: deleting
            // or editing them here would drop live sibling bindings.
            if (/\{[^{}]*\benableFunctionsExtendedMaxDuration\b[^{}]*\}\s*=/.test(line)) return line;
            if (/^[ \t]*enableFunctionsExtendedMaxDuration\s*(?::\s*[A-Za-z_$][\w$]*)?\s*,?\s*$/.test(line)) return line;
            // bare `case '<event>':` label with body on following lines -
            // removing only the label would merge switch branches.
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // inline identifier lists: drop the name, keep siblings
            let edited = line.replace(/\{([^{}]*\benableFunctionsExtendedMaxDuration\b[^{}]*)\}/g, (m, names, offset, str) => {
              if (/^\s*=[^=]/.test(str.slice(offset + m.length))) return m; // destructuring: AST track
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n !== '');
              // only prune plain identifier lists - template-literal
              // interpolations and member chains are not sibling names
              if (!list.every((n) => /^[A-Za-z_$][\w$]*$/.test(n))) return m;
              return `{ ${list.filter((n) => n !== FLAG).join(', ')} }`;
            });
            // single-line object property (inline form): drop the entry, keep siblings
            edited = edited
              .replace(/\benableFunctionsExtendedMaxDuration\s*:\s*[^,}\n]+?\s*,\s*/g, '')
              .replace(/,\s*enableFunctionsExtendedMaxDuration\s*:\s*[^,}\n]+/g, '')
              .replace(/\{\s*enableFunctionsExtendedMaxDuration\s*:\s*[^,}\n]+?\s*\}/g, '{}');
            if (edited !== line) return edited.trim() === '' ? null : edited;
            return null; // remaining balanced lines are dead reads/writes
          }).filter((line) => line !== null).join('\n');
          return out;
        },
      },
      {
        desc: 'Remove unreferenced enableFunctionsExtendedMaxDuration bindings from flat resourceConfig destructuring patterns (AST track)',
        // AST-track pass over the destructuring patterns the line-level rule
        // honestly leaves alone (multi-line patterns, aliased forms). The
        // flag name is distinctive but not unique - in-house job configs
        // bind it too (see the scheduler guard fixture) - so the pass
        // layers an anchor gate on top of the primitive's guards: EVERY
        // flat destructuring pattern in the file that binds the flag must
        // have a right-hand side anchored to a member chain ending at
        // .resourceConfig (the negative lookahead rejects deeper chains);
        // one unanchored pattern (an in-house tuning row, say) and the
        // whole file is skipped. Patterns that pass the gate go through
        // removeDestructuredProperty, which only removes a binding when it
        // is flat, default/rest-free and has zero other code-region
        // references (member access and string/comment mentions never
        // count) - so an aliased binding that stays live survives intact.
        detect: /\{[^{}]*\benableFunctionsExtendedMaxDuration\b[^{}]*\}\s*=/,
        apply: (t) => {
          const vercelCtx = /api\.vercel\.com/.test(t) || /\/v\d+\/projects\b/.test(t) || /\bvercel\b/i.test(t);
          if (!vercelCtx) return t;
          // chain must end at .resourceConfig (the owning object itself)
          const ANCHOR = /\.\s*resourceConfig\b(?!\s*\??\.)/;
          const pat = /\{[^{}]*\benableFunctionsExtendedMaxDuration\b[^{}]*\}\s*=\s*([^;\n]*)/g;
          let sawPattern = false;
          let allAnchored = true;
          for (const m of t.matchAll(pat)) {
            sawPattern = true;
            if (!ANCHOR.test(m[1])) { allAnchored = false; break; }
          }
          if (!sawPattern || !allAnchored) return t;
          return removeDestructuredProperty(t, 'enableFunctionsExtendedMaxDuration');
        },
      },
    ],
  },
  'vercel-project-public-source-removal': {
    provider: 'vercel',
    title: 'Vercel Projects: publicSource dropped from all project response schemas (v1.28.0)',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.27.0 vs v1.28.0: project get/list/create/update responses, microfrontends project lists, deployment projectSettings)',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #6427/#6431/#6433/#6438/#6440/#6444/#6449/#6457/#6462
    // record the removal of the publicSource field from every project
    // response schema. Verified against cached OAS snapshots: the token
    // appears 14 times in v1.27.0 and only 4 times from v1.28.0 onward.
    // The survivors are request-side properties explicitly marked
    // deprecated:true ("Accepted for backwards compatibility but ignored")
    // and the project event payload, which still carries the field as a
    // required boolean. The mend therefore deletes response reads
    // (destructuring, conditionals, display logic) and proactively drops
    // the ignored request property, while leaving every event-payload
    // read untouched — that surface still exists upstream.
    covers: [6427, 6431, 6433, 6438, 6440, 6444, 6449, 6457, 6462],
    rules: [
      {
        desc: 'Remove publicSource response reads and ignored request writes from project API consumers; event-payload reads are preserved (that surface survives)',
        // Conservative guards: only rewrite files that clearly talk to the
        // Vercel project API (api host, a versioned /projects path, or an
        // explicit vercel marker). Any line that touches an event payload
        // is left byte-identical because the event schema still carries
        // the field. Removal shapes are all line-bounded; lines with
        // unbalanced brackets (multi-line values) are left to the AST
        // track rather than break syntax.
        detect: /\bpublicSource\b/,
        apply: (t) => {
          const vercelCtx = /api\.vercel\.com/.test(t) || /\/v\d+\/projects\b/.test(t) || /\bvercel\b/i.test(t);
          if (!vercelCtx) return t;
          const balanced = (line) => {
            for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
              if (line.split(o).length !== line.split(c).length) return false;
            }
            return true;
          };
          const eventSurface = (line) => /\bpayload\b/.test(line);
          return t.split('\n').map((line) => {
            if (!/\bpublicSource\b/.test(line)) return line;
            if (eventSurface(line)) return line; // event payload still has the field
            if (!balanced(line)) return line; // multi-line value: AST track
            // bare `case '<label>':` with body on following lines — never merge branches
            if (/^[ \t]*case\b/.test(line) && /:\s*$/.test(line)) return line;
            // destructuring / inline identifier lists: drop the name, keep siblings
            let out = line.replace(/\{([^{}]*\bpublicSource\b[^{}]*)\}/g, (m, names) => {
              if (/:/.test(names)) return m;
              const list = names.split(',').map((n) => n.trim()).filter((n) => n && n !== 'publicSource');
              return `{ ${list.join(', ')} }`;
            });
            // single-line object property (inline form): drop the entry, keep siblings
            out = out
              .replace(/\bpublicSource\s*:\s*[^,}\n]+?\s*,\s*/g, '')
              .replace(/,\s*publicSource\s*:\s*[^,}\n]+/g, '')
              .replace(/\{\s*publicSource\s*:\s*[^,}\n]+?\s*\}/g, '{}');
            if (out !== line) return out.trim() === '' ? null : out;
            // remaining balanced lines referencing the token are dead
            // reads/writes (property line, conditional, display statement)
            return null;
          }).filter((line) => line !== null).join('\n');
        },
      },
    ],
  },
  'vercel-store-agent-skill-url-to-agent-skills': {
    provider: 'vercel',
    title: 'Vercel Marketplace stores: product.agentSkillUrl reshaped into the agentSkills array (v1.28.3)',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.28.2 vs v1.28.3: POST /v1/storage/stores/integration/direct response)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // spec-diff change #4523 records the removal of the scalar
    // store.product.agentSkillUrl string. Verified against cached OAS
    // snapshots: present through v1.28.2 (1 occurrence), absent from
    // v1.28.3, which introduces agentSkills — an array on the same product
    // object whose description is the plural of the old field's. The mend
    // rewrites single-URL reads to the first array entry with optional
    // chaining, preserving the read's null-safety for products that ship
    // no skill guides.
    covers: [4523],
    rules: [
      {
        desc: 'Rewrite product.agentSkillUrl member reads to agentSkills?.[0] (scalar-to-array successor)',
        // Conservative guards: only rewrite files with clear Vercel
        // context, and only member-access reads (`x.agentSkillUrl`).
        // Destructuring forms need a binding rewrite and are left to the
        // AST track. The rewrite output never contains the legacy token,
        // so the rule is naturally idempotent.
        detect: /\.agentSkillUrl\b/,
        apply: (t) => {
          const vercelCtx = /api\.vercel\.com/.test(t) || /\/v\d+\/storage\/stores\b/.test(t) || /\bvercel\b/i.test(t);
          if (!vercelCtx) return t;
          return t.replace(/(\??\.)agentSkillUrl\b/g, (_m, dot) => `${dot === '?.' ? '?.' : '.'}agentSkills?.[0]`);
        },
      },
    ],
  },
  'vercel-vcr-image-id-or-digest-rename': {
    provider: 'vercel',
    title: 'Vercel VCR: single-image fetch path parameter widened from imageId to imageIdOrDigest (v1.28.9)',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.28.8 vs v1.28.9: GET /v1/vcr/repository/{idOrName}/images/*)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // spec-diff change #5226 records the removal of
    // GET /v1/vcr/repository/{idOrName}/images/{imageId}. Verified against
    // cached OAS snapshots: v1.28.9 re-declares the same
    // getRepositoryImage operation at .../images/{imageIdOrDigest}
    // (identical fetch-single-image semantics; ids remain valid inputs,
    // digests are now also accepted). Path parameter names never appear on
    // the wire, so raw REST callers keep working unchanged — the breakage
    // surface is SDK-generated call sites, where the typed option key
    // renames from imageId to imageIdOrDigest. Critically, the sibling
    // DELETE operation keeps its imageId parameter in v1.28.9/v1.28.10, so
    // the mend is scoped to getRepositoryImage call sites only.
    covers: [5226],
    rules: [
      {
        desc: 'getRepositoryImage: rename the imageId option key to imageIdOrDigest inside the call options object (delete call sites keep imageId — that parameter survives)',
        // Conservative guards: the rename is anchored inside a
        // getRepositoryImage(...) call's option object, so imageId keys on
        // unrelated objects (including deleteRepositoryImage options) are
        // never touched. Only single-line-reachable option objects are
        // rewritten; the key rename makes the rule naturally idempotent.
        detect: /getRepositoryImage/,
        apply: (t) => t.replace(
          /(getRepositoryImage\s*\(\s*\{[^}]*?)(['"]?)\bimageId\b\2(\s*:)/g,
          (_m, head, q, colon) => `${head}${q}imageIdOrDigest${q}${colon}`,
        ).replace(
          /(getRepositoryImage\s*\(\s*\{\s*)\bimageId\b(\s*[,}])/g,
          (_m, head, tail) => `${head}imageIdOrDigest: imageId${tail}`,
        ).replace(
          /(getRepositoryImage\s*\(\s*\{[^}]*?,\s*)\bimageId\b(\s*[,}])/g,
          (_m, head, tail) => `${head}imageIdOrDigest: imageId${tail}`,
        ),
      },
    ],
  },
  'vercel-integration-resource-edge-config-read-move': {
    provider: 'vercel',
    title: 'Vercel Marketplace: experimentation edge-config fields dropped from the single-resource read (v1.28.9) — reads move to the list endpoint',
    reference: 'https://github.com/vercel/sdk (OAS snapshots v1.28.8 vs v1.28.9: GET /v1/installations/{integrationConfigurationId}/resources/{resourceId})',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // spec-diff changes #5222/#5223 record the removal of
    // protocolSettings.experimentation.edgeConfigSyncingEnabled and
    // edgeConfigTokenId from the single-resource 200 response. Verified
    // against cached OAS snapshots: both fields present on that endpoint in
    // v1.28.8, absent in v1.28.9/v1.28.10, and both survive on the sibling
    // list endpoint GET /v1/installations/{id}/resources (per resource
    // item) with identical semantics. The mend rewrites the single-resource
    // fetch into a list fetch plus a find over the returned resources.
    // Identity mapping verified against the v1.28.9 spec: the single read's
    // path parameter and its `id` response field are both described as the
    // 3rd-party provider's ID, which on list items is the `partnerId`
    // field (list items carry partnerId/internalId, never `id`), so the
    // find matches on partnerId.
    covers: [5222, 5223],
    rules: [
      {
        desc: 'Rewrite single-resource installation reads that consume the removed experimentation fields into a list-endpoint read plus find-by-partnerId',
        // Conservative guards: the rewrite only fires in files that BOTH
        // read one of the removed experimentation fields AND fetch the
        // single-resource URL as a one-line template-literal await call.
        // Files reading the single-resource endpoint for surviving fields
        // are untouched (that endpoint still works for them). Multi-line
        // call shapes and SDK-typed call sites are left to the AST track.
        detect: /\bedgeConfig(?:SyncingEnabled|TokenId)\b/,
        apply: (t) => {
          if (!/\/v\d+\/installations\//.test(t)) return t;
          const lineRe = /^([ \t]*)const\s+(\w+)\s*=\s*await\s+([\w$.]+)\(\s*`([^`\n]*\/installations\/\$\{[\w$.]+\}\/resources)\/\$\{(\w+)\}`\s*([^)\n]*)\)\s*;\s*$/;
          return t.split('\n').map((line) => {
            const m = line.match(lineRe);
            if (!m) return line;
            const [, ind, v, fn, base, idVar, rest] = m;
            return `${ind}const ${v}List = await ${fn}(\`${base}\`${rest});\n`
              + `${ind}const ${v} = (${v}List.resources || []).find((r) => r.partnerId === ${idVar});`;
          }).join('\n');
        },
      },
    ],
  },
  'cloudflare-typescript-v7-deterministic-renames': {
    provider: 'cloudflare',
    title: 'cloudflare-typescript v7.0.0: Id->ID method renames, DEXTest type renames, import-path moves, fileFromPath removal',
    reference: 'https://github.com/cloudflare/cloudflare-typescript/releases/tag/v7.0.0',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #141 is the v7.0.0 major release. This pack mends only the
    // deterministic grade documented in the release body: the 11 explicit
    // Id->ID method renames (vectorize.indexes + realtimeKit), the 4
    // DEXTest* return-type renames to SchemaHTTP/SchemaHTTPS, the
    // APIClient -> BaseCloudflare import move, cloudflare/src/* import
    // paths, and the removed fileFromPath helper. The signature grade
    // (232 methods moving intermediate path params into the options
    // object, 792 casing changes, web-stream body consumers) needs
    // argument-position awareness and stays on the AST track. Unlike the
    // upstream migration CLI (documented as non-idempotent and unsafe on
    // partially migrated code), every rule here is idempotent and a no-op
    // on already-migrated call sites.
    covers: [141],
    rules: [
      {
        desc: 'Rename Id-suffixed SDK methods to their v7 ID-cased names (whitelisted map, syntax-aware)',
        // Conservative guard: the file must import the cloudflare SDK, and
        // the rename only fires on a member call (leading dot), so
        // same-named helpers on unrelated objects in non-SDK files are
        // never touched. New names differ from old ones -> idempotent.
        // Rewrites go through astlite renameCall, so mentions of the legacy
        // names inside strings, template literals, and comments survive
        // untouched (the classic blind-regex corruption mode).
        detect: /\.(?:deleteByIds|getByIds|getMeetingById|replaceMeetingById|updateMeetingById|getPresetById|getParticipantDataFromPeerId|getWebhookById|getActiveLivestreamsForLivestreamId|getLivestreamSessionDetailsForSessionId|getLivestreamSessionForLivestreamId)\s*\(/,
        apply: (t) => {
          if (!hasCloudflareSdkImport(t)) return t;
          const map = {
            deleteByIds: 'deleteByIDs',
            getByIds: 'getByIDs',
            getMeetingById: 'getMeetingByID',
            replaceMeetingById: 'replaceMeetingByID',
            updateMeetingById: 'updateMeetingByID',
            getPresetById: 'getPresetByID',
            getParticipantDataFromPeerId: 'getParticipantDataFromPeerID',
            getWebhookById: 'getWebhookByID',
            getActiveLivestreamsForLivestreamId: 'getActiveLivestreamsForLivestreamID',
            getLivestreamSessionDetailsForSessionId: 'getLivestreamSessionDetailsForSessionID',
            getLivestreamSessionForLivestreamId: 'getLivestreamSessionForLivestreamID',
          };
          let out = t;
          for (const [oldName, newName] of Object.entries(map)) {
            out = renameCall(out, new RegExp(`\\.${oldName}\\b`), `.${newName}`);
          }
          return out;
        },
      },
      {
        desc: 'Rename removed DEXTest* response types to their SchemaHTTP/SchemaHTTPS successors',
        detect: /\bDEXTest(?:Create|Update|Get|List)Response/,
        apply: (t) => {
          if (!hasCloudflareSdkImport(t)) return t;
          // Syntax-aware identifier rename: import specifiers, type
          // annotations, and JSDoc type references are rewritten; mentions
          // of the legacy names inside strings, template literal text, and
          // prose comments survive untouched (blind-regex corruption mode).
          const map = {
            DEXTestListResponsesV4PagePaginationArray: 'SchemaHTTPSV4PagePaginationArray',
            DEXTestListResponse: 'SchemaHTTPS',
            DEXTestCreateResponse: 'SchemaHTTP',
            DEXTestUpdateResponse: 'SchemaHTTP',
            DEXTestGetResponse: 'SchemaHTTP',
          };
          let out = t;
          for (const [oldName, newName] of Object.entries(map)) {
            out = renameIdentifier(out, oldName, newName, { includeJsdoc: true });
          }
          return out;
        },
      },
      {
        desc: 'Move the APIClient base-class import from cloudflare/core to BaseCloudflare from cloudflare/client',
        // Only fires when the exact legacy import is present, then renames
        // the remaining APIClient references in the same file; APIClient
        // tokens without that import (unrelated frameworks) stay put.
        // Syntax-aware identifier rename: code references (extends clauses,
        // instanceof checks, type positions) are rewritten; mentions of the
        // legacy name inside strings, template literal text, and prose
        // comments survive untouched (blind-regex corruption mode).
        detect: /\bAPIClient\b/,
        apply: (t) => {
          if (!/import\s*\{\s*APIClient\s*\}\s*from\s*(['"])cloudflare\/core\1/.test(t)) return t;
          const rewired = t.replace(/import\s*\{\s*APIClient\s*\}\s*from\s*(['"])cloudflare\/core\1;?/, 'import { BaseCloudflare } from $1cloudflare/client$1;');
          return renameIdentifier(rewired, 'APIClient', 'BaseCloudflare');
        },
      },
      {
        desc: 'Rewrite removed cloudflare/src/* import paths to cloudflare/*',
        detect: /['"]cloudflare\/src\//,
        apply: (t) => t.replace(/(['"])cloudflare\/src\//g, '$1cloudflare/'),
      },
      {
        desc: 'Replace the removed fileFromPath helper with fs.createReadStream',
        // Only fires when fileFromPath is imported from the cloudflare
        // package; drops it from the import list, rewrites call sites
        // (awaited or not - createReadStream is synchronous), and adds a
        // node:fs import when the file has none.
        detect: /\bfileFromPath\b/,
        apply: (t) => {
          if (!/import\s+[^;\n]*\bfileFromPath\b[^;\n]*from\s*(['"])cloudflare\1/.test(t)) return t;
          let out = t
            .replace(/import\s+(\w+)\s*,\s*\{\s*fileFromPath\s*\}\s*from\s*(['"])cloudflare\2;?/, 'import $1 from $2cloudflare$2;')
            .replace(/import\s*\{\s*fileFromPath\s*\}\s*from\s*(['"])cloudflare\1;?\n?/, '')
            .replace(/await\s+fileFromPath\s*\(/g, 'fs.createReadStream(')
            .replace(/\bfileFromPath\s*\(/g, 'fs.createReadStream(');
          if (!/from\s*['"]node:fs['"]/.test(out) && !/require\(['"]node:fs['"]\)/.test(out)) {
            out = out.replace(/^(import [^\n]*\n)/m, `$1import fs from 'node:fs';\n`);
          }
          return out;
        },
      },
    ],
  },
  'cloudflare-typescript-v7-named-path-params': {
    provider: 'cloudflare',
    title: 'cloudflare-typescript v7.0.0: intermediate path parameters move into the options object (named path parameters)',
    reference: 'https://github.com/cloudflare/cloudflare-typescript/blob/v7.0.0/bin/migration-config.json (official migration table, cached in loop/cache/cloudflare/)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #141 (v7.0.0) also carries the signature-grade surface this
    // pack mends: for methods with multiple path parameters, every path
    // parameter except the LAST moves into the options object as a named
    // snake_case key. The per-method mapping below was extracted
    // mechanically from the SDK's own bin/migration-config.json shipped in
    // the v7.0.0 tag (243 methods; 6 rulesets/policies methods flagged
    // maybeOverload upstream are excluded - their old params argument is
    // ambiguous with request options, so rewriting them would be a guess).
    // Scope: single-line call sites whose member chain ends with the full
    // documented resource chain (e.g. `.kv.namespaces.values.get(`). The
    // paypal #625 splitter paradigm is reused: a string-aware bracket-depth
    // argument scanner, multi-line / template-literal / comment call sites
    // are skipped for the AST track. Unlike the upstream migration CLI
    // (documented as non-idempotent and unsafe on partially migrated code),
    // a migrated call site no longer matches the old positional shape (an
    // object literal sits inside the leading positional slots), so the rule
    // is a natural no-op on already-migrated code.
    covers: [141],
    // SDK method chains this pack rewrites (module-level table keys) —
    // consumed by `mendapi deps --match` to join a repo's sdk-call surfaces
    // against monitored changes at method-chain precision.
    chains: Object.keys(CF_V7_MOVED),
    rules: [
      {
        desc: 'Move intermediate positional path parameters into the options object (last path parameter stays positional)',
        detect: /\.(?:\w+)\s*\.\s*\w+\s*\(/,
        apply: (t) => {
          if (!hasCloudflareSdkImport(t)) return t;
          // method chain -> moved path-param keys (all old path params
          // except the last), from the official v7 migration table.
          // method chain -> moved path-param keys: module-level CF_V7_MOVED
          // (hoisted so `mendapi deps --match` can join sdk-call surfaces
          // against this pack via the `chains` metadata below).
          const MOVED = CF_V7_MOVED;

          // leaf method name -> candidate base chains (precomputed once).
          const byLeaf = new Map();
          for (const key of Object.keys(MOVED)) {
            const segs = key.split('.');
            const leaf = segs.pop();
            if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
            byLeaf.get(leaf).push({ base: segs, moved: MOVED[key] });
          }
          // String-aware bracket-depth argument splitter (paypal #625
          // paradigm): null on multi-line calls, template literals, or
          // comments - those go to the AST track.
          const splitArgs = (s, from) => {
            let depth = 1;
            const args = [];
            let cur = '';
            let i = from;
            while (i < s.length) {
              const ch = s[i];
              if (ch === '\n') return null;
              if (ch === "'" || ch === '"') {
                const q = ch;
                cur += ch;
                i++;
                while (i < s.length && s[i] !== q) {
                  if (s[i] === '\\') { cur += s[i]; i++; }
                  if (i < s.length) { cur += s[i]; i++; }
                }
                if (i >= s.length) return null;
                cur += q;
                i++;
                continue;
              }
              if (ch === '`' || (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*'))) return null;
              if (ch === '(' || ch === '[' || ch === '{') depth++;
              else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth === 0) return { args: cur.trim() ? [...args, cur.trim()] : args, end: i };
              }
              if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; }
              else cur += ch;
              i++;
            }
            return null;
          };
          const callRe = /((?:\w+\s*\.\s*)+)(\w+)\s*\(/g;
          let out = '';
          let last = 0;
          let m;
          while ((m = callRe.exec(t)) !== null) {
            const cands = byLeaf.get(m[2]);
            if (!cands) continue;
            const chain = m[1].replace(/\s+/g, '').split('.').filter(Boolean);
            let moved = null;
            for (const c of cands) {
              if (chain.length < c.base.length) continue;
              const tail = chain.slice(chain.length - c.base.length);
              if (tail.every((seg, k) => seg === c.base[k])) { moved = c.moved; break; }
            }
            if (!moved) continue;
            const open = m.index + m[0].length;
            const parsed = splitArgs(t, open);
            if (!parsed) continue;
            const { args, end } = parsed;
            const n = moved.length;
            // Old shape needs the moved params plus the trailing positional
            // path param. Fewer args, or an object literal / hole inside the
            // leading positional slots (the already-migrated shape), or more
            // args than path params + params object + request options:
            // leave untouched. Natural idempotency lives here.
            if (args.length < n + 1 || args.length > n + 3) continue;
            const lead = args.slice(0, n + 1);
            if (lead.some((a) => a.startsWith('{') || a === 'undefined' || a === 'null')) continue;
            const paramsArg = args.length > n + 1 ? args[n + 1] : null;
            const optionsArg = args.length > n + 2 ? args[n + 2] : null;
            // A non-literal params argument (identifier/call) cannot be
            // merged safely - skip rather than guess.
            if (paramsArg !== null && !paramsArg.startsWith('{')) continue;
            // Already migrated: the params object carries a moved key.
            if (paramsArg !== null && moved.some((k) => new RegExp(`[{,]\\s*(?:'${k}'|\"${k}\"|${k})\\s*:`).test(paramsArg))) continue;
            const pairs = moved.map((k, idx) => (args[idx] === k ? k : `${k}: ${args[idx]}`));
            const inner = paramsArg ? paramsArg.slice(1, -1).trim().replace(/,$/, '') : '';
            const merged = inner ? `{ ${pairs.join(', ')}, ${inner} }` : `{ ${pairs.join(', ')} }`;
            const rebuilt = optionsArg ? `${args[n]}, ${merged}, ${optionsArg}` : `${args[n]}, ${merged}`;
            out += t.slice(last, open) + rebuilt;
            last = end;
            callRe.lastIndex = end;
          }
          out += t.slice(last);
          return out;
        },
      },
    ],
  },
  'cloudflare-account-roles-to-permission-groups': {
    provider: 'cloudflare',
    title: 'Cloudflare Account Roles API -> Permission Groups API (URL move + meta.label read remap)',
    reference: 'https://developers.cloudflare.com/changelog/post/2026-07-21-account-role-api-deprecated/',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1386 deprecates the Account Roles API in favor of the
    // Permission Groups API. This pack mends the deterministic grade
    // documented in the notice: list/read URLs move from
    // /accounts/{id}/roles to /accounts/{id}/iam/permission_groups, and the
    // legacy top-level role label read moves to the group's meta.label
    // field. Out of scope (documented in the llm-fix asset): consumers of
    // the per-resource edit/read permission flags (that projection has no
    // successor - scope checks against meta.scopes replace it) and the
    // one-time remapping of persisted legacy role IDs, which is an
    // operational data migration rather than a codemod.
    covers: [1386],
    rules: [
      {
        desc: 'Rewrite /accounts/{id}/roles URLs to /accounts/{id}/iam/permission_groups (list and single-record reads)',
        // Conservative guards: only template-literal account URLs are
        // rewritten (the documented raw REST shape), and only in files with
        // clear Cloudflare context. The rewritten path no longer matches the
        // legacy segment, so the rule is naturally idempotent.
        detect: /accounts\/\$\{[^}]*\}\/roles\b/,
        apply: (t) => {
          if (!/api\.cloudflare\.com/.test(t) && !/\bcloudflare\b/i.test(t)) return t;
          return t.replace(/(accounts\/\$\{[^}]*\})\/roles\b/g, '$1/iam/permission_groups');
        },
      },
      {
        desc: 'Remap legacy role label reads to meta.label inside find/filter callbacks over the fetched result',
        // Conservative guards: fires only in files that fetch the account
        // roles / permission-groups URL, and only rewrites the callback
        // parameter's own label read inside a `.result.find|filter((x) =>
        // x....)` shape - same-named fields on unrelated collections in
        // other files are never touched. Output no longer matches the
        // legacy member, so the rule is naturally idempotent.
        detect: /\.result\.(?:find|filter)\(/,
        apply: (t) => {
          if (!/api\.cloudflare\.com/.test(t) && !/\bcloudflare\b/i.test(t)) return t;
          if (!/accounts\/\$\{[^}]*\}\/(?:iam\/permission_groups|roles)\b/.test(t)) return t;
          return t.replace(
            /(\.result\.(?:find|filter)\(\s*\((\w+)\)\s*=>\s*)\2\.description\b/g,
            (_m, head, param) => `${head}${param}.meta.label`,
          );
        },
      },
    ],
  },
  'cloudflare-workers-ai-model-slug-renames': {
    provider: 'cloudflare',
    title: 'Cloudflare Workers AI: omni-/ray- prefixed model slugs removed — rename to canonical successors',
    reference: 'cloudflare OAS corridor b61f904f10c9 -> 7abe88500e55 (removals subset, cached in loop/cache/cf-oas/); llm-fix assets 104114-104122',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // changes #104114-#104122 are path-removed records for nine Workers AI
    // model slugs. Walking both cached specs shows each removed slug has a
    // canonical successor that exists on BOTH sides (the omni-/ray- names
    // were aliases), so the mend is a one-token slug substitution — in
    // AI binding run() calls and in raw REST /ai/run/ URLs alike. The
    // detr-resnet-50 case renames omni- to nonomni- (its documented
    // successor), not to a bare slug.
    covers: [104114, 104115, 104116, 104117, 104118, 104119, 104120, 104121, 104122],
    rules: [
      {
        desc: 'Rename removed omni-/ray- prefixed Workers AI model slugs to their canonical successors (AI binding run() calls and REST /ai/run URLs)',
        // Conservative guard: the file must actually invoke Workers AI —
        // either the Workers binding (`AI.run(`/`env.AI.run(`) or a raw
        // REST `/ai/run/` URL. Catalog/docs files that merely mention a
        // slug without calling the API are never touched. Model slugs are
        // full-token unique strings (provider-qualified `@cf/...` paths),
        // so exact-string substitution is precise; every replacement output
        // no longer contains its source slug, making the rule idempotent
        // (facebook/omni-detr -> facebook/nonomni-detr does not re-match:
        // the map key requires the slash-delimited omni- prefix).
        detect: /@cf\/(?:baai\/(?:omni|ray)-bge-|facebook\/omni-(?:bart-large-cnn|detr-resnet-50)|google\/omni-embeddinggemma-300m|huggingface\/omni-distilbert-sst-2-int8)/,
        apply: (t) => {
          if (!/\bAI\s*\.\s*run\s*\(/.test(t) && !/\/ai\/run\//.test(t)) return t;
          const SLUG_RENAMES = {
            '@cf/baai/omni-bge-base-en-v1.5': '@cf/baai/bge-base-en-v1.5',
            '@cf/baai/omni-bge-large-en-v1.5': '@cf/baai/bge-large-en-v1.5',
            '@cf/baai/omni-bge-m3': '@cf/baai/bge-m3',
            '@cf/baai/omni-bge-small-en-v1.5': '@cf/baai/bge-small-en-v1.5',
            '@cf/baai/ray-bge-large-en-v1.5': '@cf/baai/bge-large-en-v1.5',
            '@cf/facebook/omni-bart-large-cnn': '@cf/facebook/bart-large-cnn',
            '@cf/facebook/omni-detr-resnet-50': '@cf/facebook/nonomni-detr-resnet-50',
            '@cf/google/omni-embeddinggemma-300m': '@cf/google/embeddinggemma-300m',
            '@cf/huggingface/omni-distilbert-sst-2-int8': '@cf/huggingface/distilbert-sst-2-int8',
          };
          let out = t;
          for (const [legacy, successor] of Object.entries(SLUG_RENAMES)) {
            out = out.split(legacy).join(successor);
          }
          return out;
        },
      },
    ],
  },
  'firebase-ai-vertexai-to-agent-platform-backend': {
    provider: 'firebase',
    title: 'Firebase AI SDK 12.17.0: VertexAIBackend deprecated in favor of AgentPlatformBackend (default location moves to global)',
    reference: 'https://github.com/firebase/firebase-js-sdk/releases/tag/firebase%4012.17.0 (@firebase/ai@2.14.0, PR #10184)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #103612 is the firebase 12.17.0 release whose only
    // breaking-flagged item is the VertexAIBackend -> AgentPlatformBackend
    // rename. The successor has an identical constructor surface; the only
    // behavioral difference is the default location (us-central1 -> global).
    // The mend therefore pins 'us-central1' explicitly on bare constructor
    // calls (preserving the legacy default exactly, per the release notes'
    // own migration instruction) and renames every other code reference
    // (imports, explicit-argument constructions, instanceof/type positions).
    covers: [103612],
    rules: [
      {
        desc: "Pin the legacy default location on bare VertexAIBackend() constructions: new VertexAIBackend() -> new AgentPlatformBackend('us-central1') (syntax-aware)",
        // Conservative guard: the file must import the firebase/ai (or the
        // scoped @firebase/ai) module — in-house classes that reuse the
        // VertexAIBackend name never match. Only zero-argument constructor
        // calls get the pinned region; explicit-argument calls keep their
        // argument and are handled by the rename rule below. Rewrites go
        // through astlite replaceCalls, so mentions of the legacy name in
        // strings, template literals, and comments survive untouched.
        detect: /new\s+VertexAIBackend\s*\(\s*\)/,
        apply: (t) => {
          if (!hasFirebaseAiImport(t)) return t;
          return replaceCalls(t, /new\s+VertexAIBackend\b/, (site, cur) => {
            const inner = cur.slice(site.argsStart + 1, site.argsEnd).trim();
            if (inner !== '') return null; // explicit argument: rename rule handles it
            return "new AgentPlatformBackend('us-central1')";
          });
        },
      },
      {
        desc: 'Rename remaining VertexAIBackend code references to AgentPlatformBackend (imports, constructions with explicit location, instanceof, type positions; syntax-aware)',
        // Runs after the pinning rule, so every surviving construction
        // already carries an explicit location and the rename is purely
        // mechanical. Import destructuring lists are deduplicated afterwards
        // so a file that already imports the successor never ends up with a
        // duplicate binding. Identifier rename is astlite-based: strings,
        // template-literal text, and prose comments keep the legacy name.
        detect: /\bVertexAIBackend\b/,
        apply: (t) => {
          if (!hasFirebaseAiImport(t)) return t;
          let out = renameIdentifier(t, 'VertexAIBackend', 'AgentPlatformBackend');
          // Deduplicate names inside firebase/ai import/require destructuring lists.
          out = out.replace(
            /\{([^{}]*)\}(\s*=\s*require\((['"])(?:@firebase|firebase)\/ai\3\)|\s*from\s*(['"])(?:@firebase|firebase)\/ai\4)/g,
            (_m, names, tail) => {
              const seen = new Set();
              const list = names.split(',').map((n) => n.trim()).filter((n) => {
                if (!n || seen.has(n)) return false;
                seen.add(n);
                return true;
              });
              return `{ ${list.join(', ')} }${tail}`;
            },
          );
          return out;
        },
      },
    ],
  },
  'slack-cli-hooks-file-move': {
    provider: 'slack',
    title: 'Slack CLI 3.0.0: slack.json relocated to .slack/hooks.json (project config move)',
    reference: 'Slack CLI 3.0.0 release notes: slack.json renamed to .slack/hooks.json (legacy path still read, --verbose warns)',
    // Explicit north-star coverage claim (see loop/coverage-report.mjs):
    // change #1377 renames the Slack CLI project hooks file from slack.json
    // to .slack/hooks.json. This is the first repo-level transform pack: the
    // `moves` primitive relocates the config file itself (byte-identical
    // content, emitted as a git rename patch), while the rewrite rule updates
    // quoted path references in source files. The filename slack.json is the
    // Slack CLI's own well-known config name, which is the context guard
    // here; the move only fires when the file exists at the repo root and
    // the new location is still empty (naturally idempotent).
    covers: [1377],
    moves: [
      {
        from: 'slack.json',
        to: '.slack/hooks.json',
        desc: 'Relocate the Slack CLI hooks config from slack.json to .slack/hooks.json (content unchanged)',
      },
    ],
    rules: [
      {
        desc: 'Rewrite quoted slack.json path references to .slack/hooks.json',
        // Only whole quoted path literals are rewritten: an optional ./ prefix
        // followed by the exact filename, closed by the same quote family.
        // Names that merely end in ...slack.json (e.g. myslack.json) never
        // match, and the rewritten path contains no slack.json token, so the
        // rule is naturally idempotent.
        detect: /['"`](?:\.\/)?slack\.json['"`]/,
        apply: (t) => t.replace(/(['"`])(?:\.\/)?slack\.json(?=['"`])/g, '$1.slack/hooks.json'),
      },
    ],
  },
  'slack-sdk-v8-errors': {
    provider: 'slack',
    title: 'Slack SDK v8 error-handling migration (ErrorCode checks -> instanceof)',
    reference: 'https://github.com/slackapi/node-slack-sdk/releases/tag/%40slack%2Fweb-api%408.0.0',
    // Explicit north-star coverage claims (see loop/coverage-report.mjs):
    // these DB change ids describe the v8 error-class redesign this pack mends.
    covers: [31, 32, 34],
    rules: [
      {
        desc: '@slack/web-api: error code equality checks -> instanceof error classes',
        detect: /@slack\/web-api/,
        apply: (t) => migrateSlackErrorCodes(t, '@slack/web-api', {
          PlatformError: 'WebAPIPlatformError',
          RequestError: 'WebAPIRequestError',
          HTTPError: 'WebAPIHTTPError',
          RateLimitedError: 'WebAPIRateLimitedError',
        }),
      },
      {
        desc: '@slack/webhook: error code equality checks -> instanceof error classes',
        detect: /@slack\/webhook/,
        apply: (t) => migrateSlackErrorCodes(t, '@slack/webhook', {
          HTTPError: 'IncomingWebhookHTTPError',
          RequestError: 'IncomingWebhookRequestError',
        }),
      },
      {
        desc: '@slack/socket-mode: error code equality checks -> instanceof error classes',
        detect: /@slack\/socket-mode/,
        apply: (t) => migrateSlackErrorCodes(t, '@slack/socket-mode', {
          WebsocketError: 'SMWebsocketError',
          PlatformError: 'SMPlatformError',
          NoReplyReceivedError: 'SMNoReplyReceivedError',
          SendWhileDisconnectedError: 'SMSendWhileDisconnectedError',
          SendWhileNotReadyError: 'SMSendWhileNotReadyError',
        }),
      },
    ],
  },
};

// True when the file imports/requires the Firebase AI module (firebase/ai or
// the scoped @firebase/ai package). Context guard for the firebase pack: the
// VertexAIBackend token on in-house classes never matches without it.
function hasFirebaseAiImport(t) {
  return /require\((['"])(?:@firebase|firebase)\/ai\1\)|from\s*(['"])(?:@firebase|firebase)\/ai\2/.test(t);
}

// True when the file imports/requires the cloudflare SDK package (bare
// 'cloudflare' or a 'cloudflare/...' subpath). Used as a conservative guard
// so cloudflare-typescript rename rules never touch unrelated codebases.
function hasCloudflareSdkImport(text) {
  return /(?:from\s*|require\s*\(\s*)['"]cloudflare(?:\/[^'"]*)?['"]/.test(text);
}

// Brace-balanced GraphQL selection removal. Deletes every selection of
// `field` from the text: when the selection carries a nested block
// (`field(args) { ... }` / `field { ... }`) the whole subtree goes with it;
// a bare `field` token on its own selection line is removed as a line.
// Member accesses (`obj.field`) are never touched. Idempotent: no matches
// means the text is returned untouched.
function removeGraphqlSelection(text, field) {
  const re = new RegExp(String.raw`(?<![\w$.])${field}(?![\w$])`, 'g');
  let t = text;
  let m;
  while ((m = re.exec(t)) !== null) {
    let start = m.index;
    let cursor = m.index + field.length;
    // Skip an optional (args) group between the field and its block.
    while (cursor < t.length && /\s/.test(t[cursor])) cursor++;
    if (t[cursor] === '(') {
      let depth = 0;
      do {
        if (t[cursor] === '(') depth++;
        else if (t[cursor] === ')') depth--;
        cursor++;
      } while (cursor < t.length && depth > 0);
      while (cursor < t.length && /\s/.test(t[cursor])) cursor++;
    }
    let end;
    if (t[cursor] === '{') {
      // Delete the balanced selection block along with the field.
      let depth = 0;
      end = cursor;
      do {
        if (t[end] === '{') depth++;
        else if (t[end] === '}') depth--;
        end++;
      } while (end < t.length && depth > 0);
    } else {
      // Bare field selection: delete just the token.
      end = m.index + field.length;
    }
    // Expand to whole line(s) when the removal leaves only blank residue.
    const lineStart = t.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = t.indexOf('\n', end - 1);
    const lineEnd = lineEndIdx === -1 ? t.length : lineEndIdx + 1;
    const remainder = t.slice(lineStart, start) + t.slice(end, lineEnd);
    if (remainder.trim() === '') {
      start = lineStart;
      end = lineEnd;
    }
    t = t.slice(0, start) + t.slice(end);
    re.lastIndex = start;
  }
  return t;
}

// Shared transform for the Slack SDK v8 error migration. Rewrites
// `x.code === ErrorCode.<Name>` (and `!==`) into `x instanceof <Class>` for
// the given package's code->class map, then updates the package's destructured
// import/require to pull in the classes (dropping ErrorCode when unused).
// Conservative guards:
//   - only runs when the file references exactly one Slack SDK package
//     (with several packages in one file, a bare `ErrorCode` is ambiguous);
//   - only rewrites codes present in the map; unknown codes are left alone.
const SLACK_PKGS = ['@slack/web-api', '@slack/webhook', '@slack/socket-mode', '@slack/oauth'];
function migrateSlackErrorCodes(text, pkg, map) {
  const present = SLACK_PKGS.filter((p) => text.includes(p));
  if (present.length !== 1 || present[0] !== pkg) return text;

  const used = new Set();
  const codes = Object.keys(map).join('|');
  let t = text.replace(
    new RegExp(String.raw`([\w$]+(?:\.[\w$]+)*)\.code\s*!==\s*ErrorCode\.(${codes})\b`, 'g'),
    (_m, obj, code) => { used.add(map[code]); return `!(${obj} instanceof ${map[code]})`; },
  );
  t = t.replace(
    new RegExp(String.raw`([\w$]+(?:\.[\w$]+)*)\.code\s*===\s*ErrorCode\.(${codes})\b`, 'g'),
    (_m, obj, code) => { used.add(map[code]); return `${obj} instanceof ${map[code]}`; },
  );
  if (used.size === 0) return text;

  const esc = pkg.replace(/[/\\]/g, '\\$&');
  const importRe = new RegExp(
    String.raw`(const\s*\{|import\s*\{)([^}]*)(\}\s*=\s*require\(['"]${esc}['"]\)|\}\s*from\s*['"]${esc}['"])`,
  );
  const m = t.match(importRe);
  if (!m) return t;
  const names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  const rest = t.replace(importRe, '');
  const keep = names.filter((n) => n !== 'ErrorCode' || new RegExp(String.raw`\bErrorCode\b`).test(rest));
  for (const cls of used) if (!keep.includes(cls)) keep.push(cls);
  return t.replace(importRe, `${m[1]} ${keep.join(', ')} ${m[3]}`);
}

// ---------- helpers ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && SCAN_EXTS.has(extname(name)) && st.size < 1_000_000) yield p;
  }
}

// Unified diff built on a line-based LCS so the output is a real patch that
// `git apply` accepts. Files handled here are small (rule packs make
// localized edits), so an O(n*m) LCS table is fine.
function splitLines(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function unifiedDiff(relPath, before, after) {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);

  // LCS table.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk the table into an edit script: {kind: ' '|'-'|'+', line}.
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: '-', line: a[i] }); i++; }
    else { ops.push({ kind: '+', line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ kind: '-', line: a[i++] }); }
  while (j < m) { ops.push({ kind: '+', line: b[j++] }); }

  // Group changes into hunks with up to 3 context lines.
  const CONTEXT = 3;
  const hunks = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === ' ') { k++; continue; }
    // Found a change; expand backwards/forwards with context.
    let start = k;
    while (start > 0 && ops[start - 1].kind === ' ' && k - start < CONTEXT) start--;
    let end = k;
    let lastChange = k;
    while (end < ops.length) {
      if (ops[end].kind !== ' ') { lastChange = end; end++; continue; }
      // Stop if the gap of context after the last change exceeds 2*CONTEXT
      // (otherwise merge into the same hunk).
      let gap = 0;
      let probe = end;
      while (probe < ops.length && ops[probe].kind === ' ') { gap++; probe++; }
      if (probe >= ops.length || gap > CONTEXT * 2) { end = Math.min(end + CONTEXT, probe); break; }
      end = probe;
    }
    hunks.push({ start, end: Math.min(end, ops.length) });
    k = end;
  }

  // Compute line numbers for each hunk.
  let out = `--- a/${relPath}\n+++ b/${relPath}\n`;
  let aLine = 1, bLine = 1, cursor = 0;
  for (const h of hunks) {
    for (; cursor < h.start; cursor++) {
      if (ops[cursor].kind === ' ') { aLine++; bLine++; }
      else if (ops[cursor].kind === '-') aLine++;
      else bLine++;
    }
    let aCount = 0, bCount = 0, body = '';
    for (let p = h.start; p < h.end; p++) {
      const op = ops[p];
      body += `${op.kind}${op.line}\n`;
      if (op.kind === ' ') { aCount++; bCount++; }
      else if (op.kind === '-') aCount++;
      else bCount++;
    }
    out += `@@ -${aLine},${aCount} +${bLine},${bCount} @@\n${body}`;
    for (; cursor < h.end; cursor++) {
      if (ops[cursor].kind === ' ') { aLine++; bLine++; }
      else if (ops[cursor].kind === '-') aLine++;
      else bLine++;
    }
  }
  return out;
}

// ---------- fix verification (GOAL: evidence chain for every patch) ----------
// Every candidate rewrite is syntax-checked with `node --check` BEFORE the
// report is written, and the verdicts ship inside fix-report.json. This is the
// first layer of the "what did this patch pass" evidence chain a reviewer (or
// a PR body) can cite mechanically instead of asserting on faith.
// TypeScript/JSX files cannot be checked by `node --check`; they are recorded
// as skipped (never silently counted as passed).
const NODE_CHECKABLE = new Set(['.js', '.mjs', '.cjs']);

function syntaxCheck(relPath, text) {
  const ext = extname(relPath);
  if (!NODE_CHECKABLE.has(ext)) return { status: 'skipped', reason: `node --check cannot parse ${ext || 'extensionless'} files` };
  const dir = mkdtempSync(join(tmpdir(), 'mendapi-syntax-'));
  const tmp = join(dir, `candidate${ext}`);
  try {
    writeFileSync(tmp, text);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status === 0) return { status: 'pass' };
    const firstLine = (r.stderr || '').split('\n').find((l) => l.trim()) || 'node --check failed';
    return { status: 'fail', reason: firstLine.replace(tmp, relPath).trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Second evidence layer: after --apply, optionally run the repo's OWN
// package.json scripts (test / typecheck only — a conservative whitelist) and
// record pass/fail per script inside verification.repo_checks. Opt-in via
// --run-checks because running arbitrary repo scripts executes third-party
// code; without the flag (or without --apply, or without matching scripts)
// the layer is honestly recorded as skipped with a reason — never silently
// counted as passed. Scripts run with the repo as cwd via `npm run` so
// node_modules/.bin resolution matches what the repo's developers see.
const REPO_CHECK_SCRIPTS = ['test', 'typecheck'];

function runRepoChecks(repoPath, opts) {
  if (!opts.runChecks) return { status: 'skipped', reason: 'pass --run-checks with --apply to run the repo test/typecheck scripts' };
  if (!opts.apply) return { status: 'skipped', reason: '--run-checks requires --apply (checks must run against the rewritten files on disk)' };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
  } catch {
    return { status: 'skipped', reason: 'repo has no readable package.json' };
  }
  const names = REPO_CHECK_SCRIPTS.filter((n) => pkg.scripts && typeof pkg.scripts[n] === 'string');
  if (names.length === 0) return { status: 'skipped', reason: `repo package.json defines none of: ${REPO_CHECK_SCRIPTS.join(', ')}` };
  const checks = [];
  for (const name of names) {
    const r = spawnSync('npm', ['run', name, '--silent'], { cwd: repoPath, encoding: 'utf8', timeout: 120000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    checks.push({
      script: name,
      command: pkg.scripts[name],
      status: r.status === 0 ? 'pass' : 'fail',
      exit_code: r.status,
      output_tail: out.split('\n').slice(-5).join('\n').slice(-400),
    });
  }
  return {
    status: 'ran',
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    checks,
  };
}

// ---------- main ----------
function runMigration(migrationName, repoPath, opts) {
  const migration = MIGRATIONS[migrationName];
  // Staleness gate (GOAL "rules must not be dead code"): if the change DB
  // holds a NEWER breaking/deprecation change on the same API surface as this
  // pack's covered changes, the pack's upstream assumption may be outdated.
  // Never apply a stale pack silently — require an explicit --ack-stale after
  // the operator re-verified the rules against the current upstream.
  const stale = checkPackFreshness(migrationName, MIGRATIONS, opts.db || undefined);
  if (stale && !opts.ackStale) {
    // Structured refusal so agents (including the MCP server, which returns
    // child stdout verbatim) never have to parse the human stderr prose.
    // Same envelope shape as a fix report; status field is the machine
    // signal, exit code 3 stays the process-level contract.
    const refusal = {
      tool: 'mendapi-fixer/0.1',
      schema_version: 1,
      migration: migrationName,
      provider: migration.provider,
      mode: opts.apply ? 'apply' : 'dry-run',
      status: 'refused-stale',
      pack_freshness: {
        status: 'needs-revalidation',
        baseline: stale.baseline,
        newer_changes: stale.newer_changes,
      },
      remedy: 'Audit with `mendapi revalidate`, then rerun with --ack-stale, or stamp revalidatedThrough on the pack.',
    };
    if (stale.suggested_revalidated_through) {
      refusal.pack_freshness.suggested_revalidated_through = stale.suggested_revalidated_through;
    }
    console.error(`Refusing to run migration '${migrationName}': pack needs revalidation.`);
    console.error(`Newer upstream changes on the same API surface since baseline ${stale.baseline}:`);
    for (const n of stale.newer_changes) console.error(`  #${n.id} (${n.published})${n.anchor ? ` ${n.anchor}` : ''}: ${n.title}`);
    console.error('Re-verify the pack rules (node app/revalidate.js), then rerun with --ack-stale to proceed.');
    if (stale.suggested_revalidated_through) {
      console.error(`Once re-verified, stamp revalidatedThrough: '${stale.suggested_revalidated_through}' on the pack to acknowledge the listed changes permanently.`);
    }
    if (opts.pipeline) {
      // --from-report pipeline: one stale pack must not abort the remaining
      // migrations or swallow the aggregate document. Record the refusal in
      // the run (structured entry in the JSON aggregate) and let main() exit
      // 3 after every applicable migration has run.
      if (opts.collect) opts.collect.push(refusal);
      if (opts.refused) opts.refused.push(migrationName);
      return 0;
    }
    if (opts.json) console.log(JSON.stringify(refusal, null, 2));
    process.exit(3);
  }
  const outDir = opts.outDir || join(ROOT, '..', 'loop', 'evidence', `fix-${migrationName}`);
  mkdirSync(outDir, { recursive: true });

  const report = {
    tool: 'mendapi-fixer/0.1',
    schema_version: 1,
    migration: migrationName,
    title: migration.title,
    provider: migration.provider,
    reference: migration.reference,
    repo: repoPath,
    mode: opts.apply ? 'apply' : 'dry-run',
    generated_at: new Date().toISOString(),
    files: [],
  };
  let fullPatch = '';
  // Repo-level file moves (e.g. config relocation packs). Each move is a
  // byte-identical relocation emitted as a git rename patch; it only fires
  // when the source file exists and the destination does not (naturally
  // idempotent). Rename blocks are appended AFTER the content hunks: a
  // rename-only "diff --git" block has no hunk body, so git would otherwise
  // misparse the next file's ---/+++ header as belonging to the rename.
  let movePatch = '';
  for (const mv of migration.moves || []) {
    const fromAbs = join(repoPath, mv.from);
    const toAbs = join(repoPath, mv.to);
    if (!existsSync(fromAbs) || existsSync(toAbs)) continue;
    movePatch += `diff --git a/${mv.from} b/${mv.to}\nsimilarity index 100%\nrename from ${mv.from}\nrename to ${mv.to}\n`;
    report.files.push({ file: mv.from, moved_to: mv.to, rules_applied: [mv.desc] });
    if (opts.apply) {
      mkdirSync(dirname(toAbs), { recursive: true });
      renameSync(fromAbs, toAbs);
    }
  }

  for (const file of walk(repoPath)) {
    const before = readFileSync(file, 'utf8');
    let after = before;
    const applied = [];
    for (const rule of migration.rules) {
      if (rule.detect.test(after)) {
        after = rule.apply(after);
        applied.push(rule.desc);
      }
    }
    if (after !== before) {
      const rel = relative(repoPath, file);
      const patch = unifiedDiff(rel, before, after);
      fullPatch += patch;
      report.files.push({ file: rel, rules_applied: applied, syntax_check: syntaxCheck(rel, after) });
      if (opts.apply) writeFileSync(file, after);
    }
  }

  // Evidence-chain summary: what this patch passed, machine-readable.
  const verdicts = report.files.map((f) => f.syntax_check).filter(Boolean);
  report.verification = {
    syntax_check: {
      tool: `node --check (${process.version})`,
      passed: verdicts.filter((v) => v.status === 'pass').length,
      failed: verdicts.filter((v) => v.status === 'fail').length,
      skipped: verdicts.filter((v) => v.status === 'skipped').length,
    },
    repo_checks: runRepoChecks(repoPath, opts),
  };
  if (report.verification.repo_checks.failed > 0) {
    console.error(`WARNING: ${report.verification.repo_checks.failed} repo check script(s) failed after apply — review before merging:`);
    for (const c of report.verification.repo_checks.checks) if (c.status === 'fail') console.error(`  npm run ${c.script} (exit ${c.exit_code})`);
  }
  if (report.verification.syntax_check.failed > 0) {
    console.error(`WARNING: ${report.verification.syntax_check.failed} rewritten file(s) failed node --check — review the patch before applying:`);
    for (const f of report.files) if (f.syntax_check && f.syntax_check.status === 'fail') console.error(`  ${f.file}: ${f.syntax_check.reason}`);
  }

  const patchPath = join(outDir, 'changes.patch');
  fullPatch += movePatch;
  const reportPath = join(outDir, 'fix-report.json');
  writeFileSync(patchPath, fullPatch);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (opts.json) {
    // Stable machine interface (schema_version above): report JSON on stdout,
    // human summary on stderr so agents never parse terminal prose.
    report.patch_path = patchPath;
    report.report_path = reportPath;
    if (opts.collect) opts.collect.push(report);
    else console.log(JSON.stringify(report, null, 2));
    console.error(`Migration: ${migration.title}`);
    console.error(`Mode: ${report.mode}`);
    console.error(`Files changed: ${report.files.length}`);
    return report.files.length;
  }
  console.log(`Migration: ${migration.title}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Files changed: ${report.files.length}`);
  for (const f of report.files) console.log(`  ${f.file}: ${f.rules_applied.length} rules`);
  console.log(`Patch: ${patchPath}`);
  console.log(`Report: ${reportPath}`);
  return report.files.length;
}

function main() {
  const args = parseArgs(process.argv);
  const opts = { apply: !!args.apply, outDir: args['out-dir'], ackStale: !!args['ack-stale'], json: !!args.json, runChecks: !!args['run-checks'], db: typeof args.db === 'string' ? args.db : undefined };

  if (args['from-report']) {
    // Scanner -> fixer pipeline: pick migrations by providers found in the report.
    let impact;
    try {
      impact = JSON.parse(readFileSync(args['from-report'], 'utf8'));
    } catch (e) {
      console.error(`Cannot read impact report: ${e.message}`);
      process.exit(2);
    }
    const repoPath = args.repo || impact.repo;
    if (!repoPath) {
      console.error('Impact report has no repo path; pass --repo explicitly.');
      process.exit(2);
    }
    const providers = new Set(impact.providers_detected || []);
    const applicable = Object.keys(MIGRATIONS).filter((m) => providers.has(MIGRATIONS[m].provider));
    const logOut = opts.json ? console.error : console.log;
    logOut(`Impact report: ${args['from-report']}`);
    logOut(`Providers detected: ${[...providers].join(', ') || '(none)'}`);
    logOut(`Applicable migrations: ${applicable.join(', ') || '(none)'}`);
    if (applicable.length === 0) {
      if (opts.json) console.log(JSON.stringify({ tool: 'mendapi-fixer/0.1', schema_version: 1, mode: opts.apply ? 'apply' : 'dry-run', migrations: [], total_files_changed: 0 }, null, 2));
      process.exit(1);
    }
    let totalChanged = 0;
    opts.pipeline = true;
    opts.refused = [];
    if (opts.json) opts.collect = [];
    for (const m of applicable) {
      logOut('');
      totalChanged += runMigration(m, repoPath, opts);
    }
    if (opts.json) {
      // One stable JSON document for the whole pipeline run (never N concatenated docs).
      const aggregate = {
        tool: 'mendapi-fixer/0.1',
        schema_version: 1,
        mode: opts.apply ? 'apply' : 'dry-run',
        migrations: opts.collect,
        total_files_changed: totalChanged,
      };
      if (opts.refused.length) aggregate.refused_stale = opts.refused;
      console.log(JSON.stringify(aggregate, null, 2));
    }
    if (opts.refused.length) {
      // Stale-pack refusals surfaced mid-pipeline: every other applicable
      // migration still ran (reports above/in the aggregate), but the run as
      // a whole is not clean — keep the exit-3 staleness contract.
      logOut(`Refused stale pack(s): ${opts.refused.join(', ')} — see refusal details above.`);
      process.exit(3);
    }
    if (totalChanged === 0) {
      logOut('No files needed changes (codebase may already be on the new API).');
      process.exit(1);
    }
    return;
  }

  if (!args.repo || !args.migration) {
    console.error('Usage: node fixer.js --repo <path> --migration <name> [--apply] [--run-checks] [--out-dir <dir>] [--ack-stale] [--db <path>] [--json]');
    console.error('       node fixer.js --from-report <impact.json> [--repo <path>] [--apply] [--run-checks] [--out-dir <dir>] [--db <path>] [--json]');
    console.error(`Available migrations: ${Object.keys(MIGRATIONS).join(', ')}`);
    process.exit(2);
  }
  if (!MIGRATIONS[args.migration]) {
    console.error(`Unknown migration: ${args.migration}`);
    process.exit(2);
  }
  const changed = runMigration(args.migration, args.repo, opts);
  if (changed === 0) process.exit(1);
}

export { MIGRATIONS, unifiedDiff };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
