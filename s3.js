// s3.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const AWS_BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';
const AWS_BUCKET_URL = (process.env.AWS_BUCKET_URL || '').replace(/\/$/, '');

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

  await s3.send(
    new PutObjectCommand({
      Bucket: AWS_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
    })
  );
  return key;
}

function urlForKey(key) {
  // Prefer explicit bucket URL if given, otherwise standard virtual-host style
  if (AWS_BUCKET_URL) return `${AWS_BUCKET_URL}/${key}`;
  return `https://${AWS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${encodeURI(key)}`;
}

async function uploadFileToS3(filePath, key, contentType = 'application/octet-stream', returnUrl = false) {
  const buffer = await fs.promises.readFile(filePath);
  await uploadBuffer(key, buffer, contentType);
  return returnUrl ? urlForKey(key) : key;
}

module.exports = { uploadBuffer, uploadFileToS3, urlForKey, s3Ready };
