/**
 * news_config accessor — STUB for Phase 1 Wave 2 (01-04).
 *
 * This stub lets worldNewsAdapter.ts compile in Wave 2. The full implementation
 * with DB read + 60-second TTL cache is written in 01-05 Task 2 (Wave 3).
 *
 * Contract (stable — downstream impl must match):
 *   export async function getConfig<T>(key: string, defaultValue: T): Promise<T>
 *
 * Stub behavior: always returns defaultValue. Once 01-05 replaces this file,
 * the same callsite reads the live news_config table.
 */
export async function getConfig<T>(_key: string, defaultValue: T): Promise<T> {
  // STUB: plan 01-05 replaces this with the DB-backed implementation.
  return defaultValue;
}
