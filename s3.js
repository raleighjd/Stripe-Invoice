// s3.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const AWS_BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';
const AWS_BUCKET_URL = (process.env.AWS_BUCKET_URL || '').replace(/\/$/, '');
const S3_USE_ACL = String(process.env.S3_USE_ACL || '').toLowerCase() === 'true';

if (!AWS_BUCKET_NAME) {
  console.warn('⚠️ AWS_BUCKET_NAME not set. s3.js will not be able to upload.');
}

const s3 = (AWS_BUCKET_NAME
  ? new S3Client({
      region: AWS_REGION,
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    })
  : null);

function s3Ready() {
  return !!(s3 && AWS_BUCKET_NAME);
}

async function uploadBuffer(key, buffer, contentType = 'application/octet-stream') {
  if (!s3Ready()) throw new Error('S3 not configured');

  const params = {
    Bucket: AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  };
  if (S3_USE_ACL) params.ACL = 'public-read';
  await s3.send(new PutObjectCommand(params));
  return key;
}

function urlForKey(key) {
  // Prefer explicit bucket URL if given, otherwise standard virtual-host style
  if (AWS_BUCKET_URL) return `${AWS_BUCKET_URL}/${key}`;
  return `https://${AWS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${encodeURI(key)}`;
}

module.exports = { uploadBuffer, urlForKey, s3Ready };

// Convenience: upload a local file path and return its public URL
async function uploadFileToS3(filePath, key, contentType = 'application/octet-stream', makePublic = true) {
  if (!s3Ready()) throw new Error('S3 not configured');
  const buffer = await fs.promises.readFile(filePath);

  const params = {
    Bucket: AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  };
  if (makePublic && S3_USE_ACL) params.ACL = 'public-read';

  await s3.send(new PutObjectCommand(params));
  return urlForKey(key);
}

module.exports.uploadFileToS3 = uploadFileToS3;
