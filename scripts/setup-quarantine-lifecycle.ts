/**
 * One-time setup script: install a DO Spaces lifecycle rule on the
 * quarantine/ prefix (90-day expiry, recovery/appeal window).
 *
 * Run once during deploy via:
 *   npx tsx scripts/setup-quarantine-lifecycle.ts
 *
 * This script talks to DigitalOcean Spaces (object storage) ONLY — it does NOT
 * connect to the production database.
 *
 * ⚠ CRITICAL: PutBucketLifecycleConfigurationCommand REPLACES the bucket's
 * ENTIRE lifecycle configuration — it is NOT additive. The bucket already has
 * the 'voice-orphan-cleanup' rule (30 days on {PREFIX}/voice/) installed by
 * setup-voice-lifecycle.ts. If this script sent ONLY a quarantine rule, it
 * would SILENTLY DELETE the voice rule. Therefore this script re-declares
 * BOTH rules in a single Rules array so neither is lost.
 *
 * If a future rule is ever added, this script (or its successor) MUST
 * include ALL existing rules in the same Rules array — never call
 * PutBucketLifecycleConfiguration with a partial rule set.
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
const QUARANTINE_PREFIX = `${PREFIX}/quarantine/`;
const QUARANTINE_TTL_DAYS = 90; // recovery/appeal window — configurable

async function main(): Promise<void> {
  console.log(`[setup-quarantine-lifecycle] Configuring lifecycle rules on bucket "${BUCKET}"`);
  console.log(`  - voice-orphan-cleanup : prefix "${VOICE_PREFIX}", 30 days (re-declared, preserved)`);
  console.log(`  - quarantine-expiry    : prefix "${QUARANTINE_PREFIX}", ${QUARANTINE_TTL_DAYS} days`);

  const rules = [
    {
      ID: 'voice-orphan-cleanup',
      Status: 'Enabled' as const,
      Filter: {
        Prefix: VOICE_PREFIX,
      },
      Expiration: {
        Days: 30,
      },
    },
    {
      ID: 'quarantine-expiry',
      Status: 'Enabled' as const,
      Filter: {
        Prefix: QUARANTINE_PREFIX,
      },
      Expiration: {
        Days: QUARANTINE_TTL_DAYS,
      },
    },
  ];

  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: {
      Rules: rules,
    },
  }));

  console.log('[setup-quarantine-lifecycle] SUCCESS: lifecycle rules installed.');
  console.log(`  Bucket : ${BUCKET}`);
  console.log('  Rules  :', JSON.stringify(rules, null, 2));
}

main().catch((err) => {
  console.error('[setup-quarantine-lifecycle] FAILED:', err);
  process.exit(1);
});
