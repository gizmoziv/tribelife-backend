/**
 * news_config accessor with 60-second TTL cache.
 *
 * Contract:
 *   getConfig<T>(key: string, defaultValue: T): Promise<T>
 *   - Returns the JSONB value stored under `key` in news_config
 *   - Returns `defaultValue` if the key is absent or DB read fails
 *   - Caches successful reads for 60s to avoid re-querying on each cron tick
 *
 * Why JSONB: D-08 — flexible key-value store; JSONB holds numbers, strings,
 * arrays, objects without schema migration. See Pitfall P-4 for seed caveats.
 *
 * Why 60s cache: RESEARCH.md § Component Responsibilities. Config changes
 * are rare; hourly cron + per-call overhead should not pound the DB.
 */
import { db } from '../../db';
import { newsConfig } from '../../db/schema';
import { eq } from 'drizzle-orm';
import logger from '../../lib/logger';

const log = logger.child({ module: 'news-config' });

const CACHE_TTL_MS = 60_000;

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  try {
    const [row] = await db
      .select({ value: newsConfig.value })
      .from(newsConfig)
      .where(eq(newsConfig.key, key))
      .limit(1);

    if (row === undefined) {
      // Key absent — cache the default so we do not repeatedly miss
      cache.set(key, { value: defaultValue, expiresAt: now + CACHE_TTL_MS });
      return defaultValue;
    }

    const value = row.value as T;
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    log.error({ err, key }, 'getConfig DB read failed — using defaultValue');
    return defaultValue;
  }
}

/**
 * Test-only: clear the TTL cache. Do not call from production code.
 */
export function _clearCache(): void {
  cache.clear();
}
