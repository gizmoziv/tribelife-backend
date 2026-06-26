/**
 * One-time setup script: install a DO Spaces lifecycle rule on the voice/ prefix.
 *
 * Run once during deploy via:
 *   npx tsx scripts/setup-voice-lifecycle.ts
 *
 * This script talks to DigitalOcean Spaces (object storage) ONLY — it does NOT
 * connect to the production database.
 *
 * Effect: any object under {PREFIX}/voice/ that is not explicitly deleted will be
 * automatically removed after 30 days. This is a long-stop orphan-cleanup safety
 * net. Active rejected/failed audio is deleted immediately by the moderation
 * service (voiceModeration.ts); 30 days avoids deleting actively-played audio
 * (Pitfall 7 — do not shorten the TTL below the realistic playback window).
 */

import 'dotenv/config';
import { S3Client, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

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
const PREFIX = process.env.DO_SPACES_PREFIX || 'prod';
const VOICE_PREFIX = `${PREFIX}/voice/`;

async function main(): Promise<void> {
  console.log(`[setup-voice-lifecycle] Configuring lifecycle rule on bucket "${BUCKET}", prefix "${VOICE_PREFIX}"`);

  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'voice-orphan-cleanup',
          Status: 'Enabled',
          Filter: {
            Prefix: VOICE_PREFIX,
          },
          Expiration: {
            Days: 30,
          },
        },
      ],
    },
  }));

  console.log('[setup-voice-lifecycle] SUCCESS: lifecycle rule "voice-orphan-cleanup" installed.');
  console.log(`  Bucket : ${BUCKET}`);
  console.log(`  Prefix : ${VOICE_PREFIX}`);
  console.log('  TTL    : 30 days (long-stop orphan cleanup — active rejections are deleted immediately by voiceModeration.ts)');
}

main().catch((err) => {
  console.error('[setup-voice-lifecycle] FAILED:', err);
  process.exit(1);
});
