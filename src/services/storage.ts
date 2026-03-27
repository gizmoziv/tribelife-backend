import { S3Client, PutObjectCommand, PutObjectAclCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ── DigitalOcean Spaces Storage Service ─────────────────────────────────────
// S3-compatible object storage for avatar uploads via pre-signed URLs.

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY!,
    secretAccessKey: process.env.DO_SPACES_SECRET!,
  },
  forcePathStyle: false,
});

const BUCKET = process.env.DO_SPACES_BUCKET!;
const CDN_URL = process.env.DO_SPACES_CDN_URL!;
const PREFIX = process.env.DO_SPACES_PREFIX || 'prod';

/**
 * Generate a pre-signed PUT URL for avatar upload.
 * Key format: {env}/avatars/{userId}/{timestamp}.jpg
 */
export async function generateAvatarUploadUrl(userId: number): Promise<{
  uploadUrl: string;
  key: string;
  cdnUrl: string;
}> {
  const key = `${PREFIX}/avatars/${userId}/${Date.now()}.jpg`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: 'image/jpeg',
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const cdnUrl = `${CDN_URL}/${key}`;

  return { uploadUrl, key, cdnUrl };
}

/**
 * Set an object's ACL to public-read so CDN can serve it.
 */
export async function setPublicRead(key: string): Promise<void> {
  await s3.send(new PutObjectAclCommand({
    Bucket: BUCKET,
    Key: key,
    ACL: 'public-read',
  }));
}

/**
 * Check if an object exists at the given key.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete an object. Logs errors but does not throw (graceful delete).
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error('[storage] Failed to delete object:', key, err);
  }
}

/**
 * Extract the object key from a CDN URL. Returns null if URL doesn't match.
 */
export function cdnUrlToKey(cdnUrl: string): string | null {
  if (!cdnUrl.startsWith(CDN_URL + '/')) {
    return null;
  }
  return cdnUrl.slice(CDN_URL.length + 1);
}
