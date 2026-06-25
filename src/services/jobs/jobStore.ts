import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { jobPostings } from '../../db/schema';
import logger from '../../lib/logger';

const log = logger.child({ module: 'job-store' });

export interface JobRow {
  source: string;
  externalRef: string;
  title: string;
  company: string;
  location: string | null;
  postedDate: string | null;
  description: string | null;
  logoUrl: string | null;
  viewCount: number;
  jobUrl: string;
}

/**
 * Upsert a batch of scraped job rows into job_postings.
 * On conflict (source, external_ref): refresh mutable fields only.
 * Immutable fields (source, externalRef, createdAt) are never overwritten.
 */
export async function upsertJobs(rows: JobRow[]): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };

  const result = await db
    .insert(jobPostings)
    .values(rows.map((r) => ({ ...r, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: [jobPostings.source, jobPostings.externalRef],
      set: {
        viewCount:   sql`EXCLUDED.view_count`,
        description: sql`EXCLUDED.description`,
        logoUrl:     sql`EXCLUDED.logo_url`,
        location:    sql`EXCLUDED.location`,
        postedDate:  sql`EXCLUDED.posted_date`,
        updatedAt:   sql`NOW()`,
        // DO NOT include: source, externalRef, createdAt (immutable — first seen preserved)
      },
    })
    .returning({ id: jobPostings.id });

  log.info({ count: result.length }, 'upsertJobs complete');
  return { inserted: result.length };
}
