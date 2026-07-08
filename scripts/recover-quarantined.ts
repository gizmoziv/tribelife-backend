/**
 * Recover a quarantined (or any) object from DO Spaces to a local file.
 *
 * Quarantined moderation media is PRIVATE (ACL private) and lives under
 * {PREFIX}/quarantine/... — you can't just open the CDN URL (it 403s). This
 * pulls the bytes down using the Spaces creds in .env (a read-scoped Limited
 * key is enough), and also prints a temporary presigned URL you can open in a
 * browser or hand to the user.
 *
 * Usage:
 *   npx tsx scripts/recover-quarantined.ts <keyOrUrl> [outputPath]
 *
 * Examples:
 *   npx tsx scripts/recover-quarantined.ts qa/quarantine/media/99/<uuid>/0.jpg
 *   npx tsx scripts/recover-quarantined.ts "https://…/qa/quarantine/…/0.jpg" ./out.jpg
 *
 * Talks to DigitalOcean Spaces ONLY — never the database.
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY!,
    secretAccessKey: process.env.DO_SPACES_SECRET!,
  },
  forcePathStyle: false,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET = process.env.DO_SPACES_BUCKET!;

/** Accept a raw object key OR a full CDN/origin URL (subdomain-style: pathname == key). */
function toKey(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    return new URL(input).pathname.replace(/^\/+/, '');
  }
  return input.replace(/^\/+/, '');
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/recover-quarantined.ts <keyOrUrl> [outputPath]');
    process.exit(1);
  }
  const key = toKey(arg);
  const outPath = process.argv[3] || `./recovered-${basename(key)}`;

  console.log(`[recover] bucket="${BUCKET}" key="${key}"`);

  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error('empty response body');
  const bytes = await res.Body.transformToByteArray();
  await writeFile(outPath, bytes);
  console.log(`[recover] saved ${bytes.length} bytes -> ${outPath}`);

  // Bonus: a temporary presigned URL (valid 1h) — open in a browser or share it.
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
  console.log(`[recover] presigned URL (valid 1h):\n${url}`);
}

main().catch((err) => {
  console.error('[recover] FAILED:', err);
  process.exit(1);
});
