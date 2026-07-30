// Legacy AWS SDK v2 usage (S3): default client, list/delete operations.
const AWS = require('aws-sdk');

const client = new AWS.S3();

async function listReports(bucket) {
  const out = await client.listObjectsV2({ Bucket: bucket, Prefix: 'reports/' }).promise();
  return (out.Contents || []).map((o) => o.Key);
}

async function removeReport(bucket, key) {
  await client.deleteObject({ Bucket: bucket, Key: key }).promise();
}

module.exports = { listReports, removeReport };
