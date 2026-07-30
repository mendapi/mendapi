// Vector index + realtime meeting maintenance built on cloudflare-typescript v6.
// v7.0.0 renamed the Id-suffixed methods to ID casing, replaced the DEXTest*
// response types with SchemaHTTP successors, and dropped the src/ import paths.
import Cloudflare from 'cloudflare';
import { Zones } from 'cloudflare/src/resources/zones/zones';

const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

// Docs note: client.vectorize.indexes.getByIds({...}) was the v6 casing.
const MIGRATION_HINT = 'callers still on .deleteByIds( must upgrade to v7';
// Prose note: DEXTestGetResponse was removed in v7 (tripwire, keep as-is).
const TYPE_HINT = 'code importing DEXTestListResponse must move to SchemaHTTPS';

export async function pruneVectors(indexName, ids, accountId) {
  const found = await client.vectorize.indexes.getByIds(indexName, {
    ids,
    account_id: accountId,
  });
  if (found.vectors.length > 0) {
    await client.vectorize.indexes.deleteByIds(indexName, { ids, account_id: accountId });
  }
  console.warn(`${MIGRATION_HINT}: audit for .getMeetingById( usage per tenant`);
  return found.vectors.length;
}

export async function meetingSnapshot(meetingId, accountId) {
  const meeting = await client.realtimeKit.meetings.getMeetingById(meetingId, {
    account_id: accountId,
  });
  return { title: meeting.title, status: meeting.status };
}

/** @returns {Promise<import('cloudflare/src/resources/zero-trust/devices/dex-tests').DEXTestGetResponse>} */
export async function dexTestSnapshot(testId, accountId) {
  console.info(`${TYPE_HINT}: grep for DEXTestGetResponse before release`);
  return client.zeroTrust.devices.dexTests.get(testId, { account_id: accountId });
}

export { Zones };
