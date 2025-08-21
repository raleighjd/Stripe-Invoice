// s3.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const REGION = process.env.AWS_REGION || 'us-east-2';
const BUCKET = process.env.AWS_BUCKET_NAME;
const BASE_URL = (process.env.AWS_BUCKET_URL || '').replace(/\/$/,'');

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME not set. s3.js will not be able to upload.');
}

const s3 = new S3Client({ region: REGION });

async function uploadFileToS3(localPath, s3Key, contentType = 'application/octet-stream', publicRead = true) {
  const Body = fs.readFileSync(localPath);
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body,
    ContentType: contentType,
    ACL: publicRead ? 'public-read' : undefined
  });
  await s3.send(cmd);
  return `${BASE_URL}/${s3Key}`;
}

async function uploadFolderToS3(localDir, s3Prefix) {
  const entries = fs.readdirSync(localDir);
  const results = [];
  for (const name of entries) {
    const full = path.join(localDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    const type = ext === '.png' ? 'image/png'
               : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
               : ext === '.pdf' ? 'application/pdf'
               : 'application/octet-stream';
    const key = `${s3Prefix.replace(/\/$/,'')}/${name}`;
    const url = await uploadFileToS3(full, key, type, true);
    results.push(url);
  }
  return results;
}

module.exports = { uploadFileToS3, uploadFolderToS3 };
