// Gold fixture: a repo using only the S3 client from the AWS SDK v3 monorepo.
// Feed changes that name other sub-API packages must be FILTERED by the
// sub-API gate; changes that name the S3 package must be kept for this repo.
// (Deliberately no other package names anywhere in this file — the scanner
// matches comments too, so naming them here would defeat the fixture.)
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function upload(bucket, key, body) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  return `s3://${bucket}/${key}`;
}

module.exports = { upload };
