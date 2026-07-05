const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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
 * - With a CDN configured (S3_PUBLIC_BASE_URL) that base is used.
 * - Otherwise a RELATIVE url ("/uploads/<key>") is returned; clients resolve
 *   it against the API base URL they already use. The API serves the file
 *   from local disk or proxies it from S3/MinIO (see the /uploads route).
 *   Presigned URLs are deliberately NOT used here: in Docker they are built
 *   on the internal endpoint (http://minio:9000), a hostname phones cannot
 *   resolve — avatars uploaded fine but never displayed.
 */
async function publicUrl(key) {
  if (!key) return null;
  if (config.storage.publicBaseUrl) return `${config.storage.publicBaseUrl}/${key}`;
  return `/uploads/${key}`;
}

/**
 * Fetch an object from S3/MinIO for proxying; returns null when the object
 * (or the object store itself) is unavailable.
 */
async function fetchObject(key) {
  try {
    return await s3.send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }));
  } catch {
    return null;
  }
}

module.exports = { upload, remove, publicUrl, fetchObject, LOCAL_DIR };
