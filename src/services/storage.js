const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const config = require('../config');

const s3 = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  forcePathStyle: config.storage.forcePathStyle,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
});

const keyFor = (folder, originalName = '') => {
  const ext = (originalName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${folder}/${crypto.randomUUID()}.${ext}`;
};

/** Upload a multer memory-buffer file; returns the storage key. */
async function upload(folder, file) {
  const key = keyFor(folder, file.originalname);
  await s3.send(new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return key;
}

async function remove(key) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
}

/** Public URL for a key. Uses CDN base if configured, else a 24h presigned URL. */
async function publicUrl(key) {
  if (!key) return null;
  if (config.storage.publicBaseUrl) return `${config.storage.publicBaseUrl}/${key}`;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }), { expiresIn: 86400 });
}

module.exports = { upload, remove, publicUrl };
