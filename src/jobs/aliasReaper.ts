/**
 * Group Slug Alias Reaper — runs daily
 *
 * Deletes old-slug aliases (group_slug_aliases) that have not been used in the
 * last 30 days. Any hit on an old slug bumps its last_used_at (see
 * resolveGroupIdBySlug in routes/groups.ts), so a still-shared invite link keeps
 * its alias alive; a truly dead one is reaped and its slug is freed for reuse.
 */
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { groupSlugAliases } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'alias-reaper' });

async function reapStaleAliases(): Promise<void> {
  // Compare entirely in the DB (now() - interval) so we never depend on the Node
  // process timezone against the `timestamp without time zone` column.
  const deleted = await db
    .delete(groupSlugAliases)
    .where(sql`${groupSlugAliases.lastUsedAt} < now() - interval '30 days'`)
    .returning({ slug: groupSlugAliases.slug });

  if (deleted.length > 0) {
    log.info({ count: deleted.length }, 'Reaped stale group slug aliases');
  }
}

export function startAliasReaperCron(): ScheduledTask {
  // Run daily at 04:00 UTC — off-peak, and clear of the 06:00 beacon matcher.
  const task = cron.schedule('0 4 * * *', async () => {
    try {
      await reapStaleAliases();
    } catch (err) {
      log.error({ err }, 'Cron job failed');
    }
  });

  log.info('Cron scheduled: daily at 04:00 UTC');
  return task;
}
