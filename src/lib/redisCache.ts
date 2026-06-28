/**
 * redisCache — a small, OPTIONAL shared cache backed by Redis/Valkey.
 *
 * Used by features that need a cross-instance cache (e.g. the Tribe "Today"
 * payload) so that horizontally-scaled pods return consistent results and don't
 * each hammer upstream APIs. This is a SEPARATE connection from the Socket.IO
 * Redis adapter (same server, different concern) — it deliberately does NOT
 * couple to socket init order.
 *
 * Design guarantees:
 *  - NEVER throws to callers. Every op degrades to a cache-miss / no-op on any
 *    error or when Redis is unavailable, so a Redis hiccup can never break a
 *    request path.
 *  - NEVER process.exit on Redis failure. Unlike the socket adapter (where Redis
 *    is mandatory), the cache is optional — losing it just means recompute.
 *  - Lazy connect on first use; reuses one connection process-wide.
 *
 * Connection URL: REDIS_URL in production, REDIS_URL_DEV in dev. When neither is
 * set, the cache is a no-op (callers recompute every time — fine for single-node
 * dev).
 */
import { createClient } from 'redis';
import logger from './logger';

const log = logger.child({ module: 'redisCache' });

const redisUrl =
  process.env.NODE_ENV === 'production'
    ? process.env.REDIS_URL
    : process.env.REDIS_URL_DEV;

type CacheClient = ReturnType<typeof createClient>;

let client: CacheClient | null = null;
let connectPromise: Promise<void> | null = null;

/**
 * Lazily create the cache client (once) and kick off its connection.
 * Returns null when no Redis URL is configured (cache disabled).
 * The 'error' listener is registered BEFORE connect() — an unlistened 'error'
 * on a node-redis client crashes the process. We only log here (never exit).
 */
function getClientLazy(): CacheClient | null {
  if (!redisUrl) return null;
  if (client) return client;

  client = createClient({
    url: redisUrl,
    // Send a PING on the idle connection every 60s. This cache is hit only when
    // someone loads the Tribe tab, so between requests the connection goes idle and
    // DO Managed Redis/Valkey closes it at the protocol level (~300s idle timeout) —
    // surfacing as a recurring "Socket closed unexpectedly" error every ~5 min. TCP
    // keepAlive does NOT reset Redis's app-level idle timer; an actual PING command
    // does. 60s is comfortably under the idle window and negligible load.
    pingInterval: 60_000,
    socket: {
      keepAlive: 30_000,
      reconnectStrategy: (retries: number) => {
        if (retries > 10) {
          // Give up reconnecting; cache degrades to no-op for this process.
          return new Error('redis cache reconnect limit exceeded');
        }
        return Math.min(Math.pow(2, retries) * 50, 2000);
      },
    },
  });

  // MUST be registered before connect(). Cache is optional → log, never exit.
  client.on('error', (err: Error) => {
    log.error({ err, event: 'redis_cache_error' }, 'Redis cache client error');
  });

  connectPromise = client.connect().then(
    () => {
      log.info({ event: 'redis_cache_connected' }, 'Redis cache connected');
    },
    (err: Error) => {
      log.error(
        { err, event: 'redis_cache_connect_failed' },
        'Redis cache connect failed — cache disabled for now',
      );
    },
  );

  return client;
}

/** Await the in-flight initial connection (if any), swallowing failures. */
async function ensureConnected(c: CacheClient): Promise<boolean> {
  if (connectPromise) {
    try {
      await connectPromise;
    } catch {
      /* logged in getClientLazy */
    }
  }
  return c.isOpen;
}

/**
 * Get a raw string value. Returns null on miss, on any error, or when the
 * cache is disabled. Distinguishing "cached null value" from "miss" is the
 * caller's job (use a sentinel wrapper).
 */
export async function redisGet(key: string): Promise<string | null> {
  const c = getClientLazy();
  if (!c) return null;
  try {
    if (!(await ensureConnected(c))) return null;
    return await c.get(key);
  } catch (err) {
    log.error({ err, key, event: 'redis_cache_get_failed' }, 'redisGet failed');
    return null;
  }
}

/**
 * Set a raw string value with a TTL (seconds). No-op on any error or when the
 * cache is disabled. ttlSeconds is floored to >= 1.
 */
export async function redisSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const c = getClientLazy();
  if (!c) return;
  try {
    if (!(await ensureConnected(c))) return;
    await c.set(key, value, { EX: Math.max(1, Math.floor(ttlSeconds)) });
  } catch (err) {
    log.error({ err, key, event: 'redis_cache_set_failed' }, 'redisSet failed');
  }
}

// ── JSON cache with in-process fallback ─────────────────────────────────────
//
// getJson/setJson layer JSON (de)serialization over the raw string ops above,
// AND add an in-process Map fallback so the cache still works in dev (no
// REDIS_URL_DEV) and during a Redis outage — without that fallback, every dev
// request is a cache miss and would re-fetch upstream every time. Like the rest
// of this module, these NEVER throw to the caller: any error degrades to a
// cache-miss / no-op. Used by the link-preview unfurl service.

interface MapEntry {
  value: string;
  expiresAt: number; // epoch ms
}

const memCache = new Map<string, MapEntry>();
const MEM_CACHE_MAX_ENTRIES = 2_000;

function memGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  // Crude bound: when full, drop the oldest insertion (Map preserves order).
  if (memCache.size >= MEM_CACHE_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000,
  });
}

/**
 * Read + JSON.parse a cached value. Returns null on miss, parse error, or any
 * failure. Falls back to the in-process Map when Redis is unavailable. Note:
 * `null` is a legal cached value (cached negatives are stored as the JSON
 * literal `null`), so callers that need to distinguish "cached null" from "miss"
 * should wrap their payload in a sentinel object.
 */
export async function getJson<T>(key: string): Promise<T | null> {
  try {
    const c = getClientLazy();
    let raw: string | null = null;
    if (c) {
      raw = await redisGet(key);
    }
    // Redis disabled or a true miss → consult the in-process fallback.
    if (raw === null) raw = memGet(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error({ err, key, event: 'redis_cache_getjson_failed' }, 'getJson failed');
    return null;
  }
}

/**
 * JSON.stringify + cache a value with a TTL (seconds). Writes to Redis when
 * available AND always to the in-process Map (so a single-pod dev/outage path
 * still serves from cache). No-op on serialization failure.
 */
export async function setJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return; // e.g. value === undefined
    memSet(key, serialized, ttlSeconds);
    const c = getClientLazy();
    if (c) {
      await redisSet(key, serialized, ttlSeconds);
    }
  } catch (err) {
    log.error({ err, key, event: 'redis_cache_setjson_failed' }, 'setJson failed');
  }
}
