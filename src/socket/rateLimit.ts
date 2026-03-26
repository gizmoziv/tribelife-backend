// ── Globe Room Rate Limiter ──────────────────────────────────────────────
// Token bucket: 1 token/sec, max 1 token (no burst)

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const REFILL_RATE = 1; // tokens per second
const MAX_TOKENS = 1;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

const buckets = new Map<string, Bucket>();

/** Returns true if the message is allowed, false if rate limited. */
export function checkRateLimit(userId: number, roomId: string): boolean {
  const key = `${userId}:${roomId}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket) {
    // First message — consume the token immediately
    buckets.set(key, { tokens: 0, lastRefill: now });
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + elapsed * REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

/** Clear all buckets (for testing). */
export function clearBuckets(): void {
  buckets.clear();
}

// Periodic cleanup of stale entries
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > STALE_THRESHOLD) {
      buckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL);
