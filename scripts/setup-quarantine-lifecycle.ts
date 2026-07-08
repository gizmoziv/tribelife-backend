/**
 * Setup script: install/maintain DO Spaces lifecycle rules for THIS environment.
 *
 * Modes:
 *   npx tsx scripts/setup-quarantine-lifecycle.ts            # apply (read-modify-write): voice(30d)+quarantine(90d)
 *   npx tsx scripts/setup-quarantine-lifecycle.ts --no-voice # apply quarantine only; also REMOVES this env's voice rule
 *   npx tsx scripts/setup-quarantine-lifecycle.ts --check    # read-only: print current rules
 *
 * --no-voice exists because the 30-day voice rule is a BLANKET expiry on
 * {PREFIX}/voice/ — it prunes active voice messages, not just orphans. If that
 * rule was never active before, enabling it retroactively deletes the whole
 * voice backlog older than 30 days on the next lifecycle sweep. Use --no-voice
 * to ship quarantine without touching (or to pull) the voice rule.
 *
 * What "apply" installs (scoped to the current DO_SPACES_PREFIX, e.g. "qa" or "prod"):
 *   - {PREFIX}/voice/       -> expire after 30 days  (rule id: {PREFIX}-voice-orphan-cleanup)
 *   - {PREFIX}/quarantine/  -> expire after 90 days  (rule id: {PREFIX}-quarantine-expiry)
 *
 * ⚠ Why this is read-modify-write (not a blind Put):
 * PutBucketLifecycleConfiguration REPLACES the bucket's ENTIRE rule set — it is
 * NOT additive. This bucket may be SHARED across environments (qa/ + prod/
 * prefixes in one bucket), so a blind Put of only this env's rules would silently
 * delete the OTHER env's rules. To stay safe, apply mode:
 *   1. GETs the existing rules.
 *   2. Drops only the rules OWNED BY THIS ENV — identified by their prefix
 *      starting with `${PREFIX}/` (this also cleans up any legacy un-namespaced
 *      voice rule for this prefix).
 *   3. Keeps every other rule (other envs, unrelated prefixes) untouched.
 *   4. Re-adds this env's two rules and PUTs the merged set, then reads it back.
 *
 * ⚠ Requires a FULL-ACCESS Spaces key — lifecycle is a bucket-config operation;
 * Limited/granular keys get `AccessDenied`. Treat that key as disposable: run
 * this once, then revoke it. This script talks to DigitalOcean Spaces ONLY — it
 * never connects to the database. Run once per environment at deploy.
 */

import 'dotenv/config';
import {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';

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
const VOICE_TTL_DAYS = 30;
const QUARANTINE_TTL_DAYS = 90; // recovery/appeal window — configurable

// The rules THIS environment owns. IDs are env-qualified so qa and prod never
// collide when they share a bucket. With includeVoice=false (--no-voice) the
// voice rule is omitted — and since apply is read-modify-write, that also
// REMOVES any existing voice rule for this env (it is simply not re-added).
function desiredRules(includeVoice: boolean): LifecycleRule[] {
  const rules: LifecycleRule[] = [
    {
      ID: `${PREFIX}-quarantine-expiry`,
      Status: 'Enabled',
      Filter: { Prefix: QUARANTINE_PREFIX },
      Expiration: { Days: QUARANTINE_TTL_DAYS },
    },
  ];
  if (includeVoice) {
    rules.push({
      ID: `${PREFIX}-voice-orphan-cleanup`,
      Status: 'Enabled',
      Filter: { Prefix: VOICE_PREFIX },
      Expiration: { Days: VOICE_TTL_DAYS },
    });
  }
  return rules;
}

/** Read a rule's prefix from either the modern Filter.Prefix or the legacy top-level Prefix. */
function rulePrefix(rule: LifecycleRule): string {
  const filter = rule.Filter as { Prefix?: string } | undefined;
  if (filter && typeof filter.Prefix === 'string') return filter.Prefix;
  const legacy = (rule as { Prefix?: string }).Prefix;
  return typeof legacy === 'string' ? legacy : '';
}

/** A rule belongs to THIS environment iff its prefix lives under `${PREFIX}/`. */
function ownedByThisEnv(rule: LifecycleRule): boolean {
  return rulePrefix(rule).startsWith(`${PREFIX}/`);
}

async function getExistingRules(): Promise<LifecycleRule[]> {
  try {
    const res = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    return res.Rules ?? [];
  } catch (err) {
    const code = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code;
    // No lifecycle config yet is not an error for our purposes — treat as empty.
    if (code === 'NoSuchLifecycleConfiguration') return [];
    throw err;
  }
}

function printRules(label: string, rules: LifecycleRule[]): void {
  console.log(`${label} (${rules.length} rule${rules.length === 1 ? '' : 's'}):`);
  if (rules.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const r of rules) {
    const days = r.Expiration?.Days;
    const owned = ownedByThisEnv(r) ? ' [this env]' : '';
    console.log(`  - ${r.ID ?? '(no id)'} | prefix="${rulePrefix(r)}" | status=${r.Status} | expire=${days ?? '—'}d${owned}`);
  }
}

async function check(): Promise<void> {
  console.log(`[setup-quarantine-lifecycle] --check on bucket "${BUCKET}" (env prefix "${PREFIX}/")`);
  const existing = await getExistingRules();
  printRules('Current lifecycle rules', existing);
  const owned = existing.filter(ownedByThisEnv).length;
  console.log(`\n${owned} rule(s) are owned by this env ("${PREFIX}/"). --check is read-only — no changes made.`);
}

async function apply(includeVoice: boolean): Promise<void> {
  console.log(`[setup-quarantine-lifecycle] apply on bucket "${BUCKET}" (env prefix "${PREFIX}/")${includeVoice ? '' : ' [--no-voice]'}`);
  const existing = await getExistingRules();
  printRules('Before', existing);

  const desired = desiredRules(includeVoice);
  const preserved = existing.filter((r) => !ownedByThisEnv(r));
  const finalRules = [...preserved, ...desired];

  if (!includeVoice && existing.some((r) => ownedByThisEnv(r) && rulePrefix(r) === VOICE_PREFIX)) {
    console.log(`\n⚠ Removing existing voice rule for "${VOICE_PREFIX}" (--no-voice) — voice backlog will NOT be pruned.`);
  }

  console.log(
    `\nPreserving ${preserved.length} rule(s) from other envs/prefixes; ` +
    `writing ${desired.length} rule(s) for "${PREFIX}/".`,
  );

  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: { Rules: finalRules },
  }));

  // Read back so the operator sees exactly what landed on the bucket.
  const after = await getExistingRules();
  printRules('\nAfter', after);
  console.log('\n[setup-quarantine-lifecycle] SUCCESS.');
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await check();
  } else {
    await apply(!process.argv.includes('--no-voice'));
  }
}

main().catch((err) => {
  console.error('[setup-quarantine-lifecycle] FAILED:', err);
  process.exit(1);
});
