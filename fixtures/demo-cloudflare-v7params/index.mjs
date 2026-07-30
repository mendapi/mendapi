// Demo consumer on cloudflare-typescript v6.x positional path parameters.
// v7.0.0 moves every path parameter except the last into the options object.
import Cloudflare from 'cloudflare';

const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

export async function readValue(nsId, key) {
  // two path params: namespace_id moves into the options object.
  return client.kv.namespaces.values.get(nsId, key, { account_id: ACCOUNT });
}

export async function dropValue(nsId, key) {
  // params object also carries request body fields that must be preserved.
  return client.kv.namespaces.values.delete(nsId, key);
}

export async function rotateCertificate(hostId, packId, certId, params) {
  // three path params: the two intermediate ones move, certificate_id stays.
  return client.customHostnames.certificatePack.certificates.update(hostId, packId, certId, { account_id: ACCOUNT, validity_days: 90 });
}

export async function auditHistory(orgId, logId) {
  return client.organizations.logs.audit.history(orgId, logId, { since: '2026-01-01' }, { maxRetries: 2 });
}

export async function alreadyMigrated(nsId, key) {
  // v7-style call: the object literal in the leading slots must keep this
  // call site untouched (idempotency / partial-migration safety).
  return client.kv.namespaces.values.get(key, { namespace_id: nsId, account_id: ACCOUNT });
}

const ACCOUNT = process.env.CF_ACCOUNT_ID;
