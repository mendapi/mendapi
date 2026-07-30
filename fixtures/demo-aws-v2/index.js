// Legacy AWS SDK v2 usage (S3): namespace client + promise-returning call style.
const AWS = require('aws-sdk');

const s3 = new AWS.S3({ region: 'us-east-1' });

async function fetchReport(bucket, key) {
  const res = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  return res.Body.toString('utf8');
}

async function saveReport(bucket, key, body) {
  await s3.putObject({ Bucket: bucket, Key: key, Body: body }).promise();
  return true;
}

module.exports = { fetchReport, saveReport };
