const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
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

// Local fallback directory (used automatically when S3/MinIO is unreachable,
// e.g. plain `npm start` in development). Served by Express at /uploads.
const LOCAL_DIR = path.join(__dirname, '..', '..', 'uploads');

const keyFor = (folder, originalName = '') => {
  const ext = (originalName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${folder}/${crypto.randomUUID()}.${ext}`;
};

const localPath = (key) => path.join(LOCAL_DIR, key);

async function localExists(key) {
  try {
    await fs.access(localPath(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload a multer memory-buffer file; returns the storage key.
 * Tries S3/MinIO first; if the object store is unreachable the file is
 * written to the local uploads/ directory instead, so avatar upload works
 * out of the box in development.
 */
async function upload(folder, file) {
  const key = keyFor(folder, file.originalname);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));
  } catch (err) {
    await fs.mkdir(path.dirname(localPath(key)), { recursive: true });
    await fs.writeFile(localPath(key), file.buffer);
  }
  return key;
}

async function remove(key) {
  if (!key) return;
  if (await localExists(key)) {
    await fs.unlink(localPath(key)).catch(() => {});
    return;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key }));
}

/**
 * Public URL for a key.
 * - Locally stored files return a RELATIVE url ("/uploads/<key>"); clients
 *   resolve it against the API base URL they already use, so it works from
 *   emulators and real devices alike.
 * - Otherwise the configured CDN base is used, falling back to a 24h
 *   presigned S3 URL.
 */
async function publicUrl(key) {
  if (!key) return null;
  if (await localExists(key)) return `/uploads/${key}`;
  if (config.storage.publicBaseUrl) return `${config.storage.publicBaseUrl}/${key}`;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }), { expiresIn: 86400 });
}

module.exports = { upload, remove, publicUrl, LOCAL_DIR };
