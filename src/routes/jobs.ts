import { Router, Response } from 'express';
import { and, desc, eq, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { jobPostings } from '../db/schema';
import { requireAuth, requireApprovedAccess, AuthRequest } from '../middleware/auth';
import { getZoneForTimezone } from '../config/timezoneZones';
import { getLocationKeywordsForZone } from '../config/jobLocationZones';
import logger from '../lib/logger';

const log = logger.child({ module: 'jobs-feed' });
const router = Router();
router.use(requireAuth);
// Phase 34 (D-17): pending/rejected users are blocked server-side, independent of the mobile block screen.
router.use(requireApprovedAccess);

const PAGE_SIZE = 20;

// ── Cursor helpers ─────────────────────────────────────────────────────────
// Opaque base64 cursor keyed on (viewCount, id) — stable compound keyset per D-05a.
// Ties on view_count broken by id (serial PK, guaranteed unique, monotonically increasing).
function encodeCursor(viewCount: number, id: number): string {
  return Buffer.from(`${viewCount}|${id}`, 'utf8').toString('base64');
}

function decodeCursor(raw: string): { viewCount: number; id: number } | null {
  try {
    const [vcStr, idStr] = Buffer.from(raw, 'base64').toString('utf8').split('|');
    const viewCount = parseInt(vcStr, 10);
    const id = parseInt(idStr, 10);
    // NaN guard — invalid cursor treated as no cursor (first page), never reflected in error
    if (isNaN(viewCount) || isNaN(id)) return null;
    return { viewCount, id };
  } catch {
    return null;
  }
}

// ── GET /feed ──────────────────────────────────────────────────────────────
// Returns view-count-DESC paginated job postings within a 60-day window.
// Implements: JOBS-04 (keyset pagination), JOBS-05 (60-day filter, no duplicates),
//             D-05 (PAGE_SIZE=20), D-05a (view_count DESC, id tiebreaker).
router.get('/feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const cursor = req.query.cursor ? decodeCursor(String(req.query.cursor)) : null;

  // D-02 / D-03: read-time 60-day age filter on posted_date (MM/DD/YYYY column).
  // Rows are NEVER deleted — filter applied at query time only.
  const ageFilter = sql`${jobPostings.postedDate} IS NOT NULL
    AND TO_DATE(${jobPostings.postedDate}, 'MM/DD/YYYY') > NOW() - INTERVAL '60 days'`;

  // Keyset cursor filter: rows with lower view_count than cursor, OR
  // same view_count with lower id (D-05a compound tiebreaker — stable under ties).
  const cursorFilter = cursor
    ? or(
        lt(jobPostings.viewCount, cursor.viewCount),
        and(eq(jobPostings.viewCount, cursor.viewCount), lt(jobPostings.id, cursor.id)),
      )
    : undefined;

  // D-04/D-05/D-09: `?myLocation=true` (strict string equality — no zod, no
  // coercion; any other value falls through to today's unfiltered behavior).
  const myLocation = req.query.myLocation === 'true';

  const locationFilter = myLocation
    ? (() => {
        // Caller's zone from their own profile timezone (server-derived, never
        // client-supplied) — null timezone falls back to the 'utc' zone.
        const zoneSlug = getZoneForTimezone(req.user!.timezone ?? 'UTC');
        const keywords = getLocationKeywordsForZone(zoneSlug);

        // Always-included: null-location jobs + jobs mentioning "remote" in any
        // casing. Built as its own variable — see LANDMINE note below.
        const alwaysIncluded = or(
          isNull(jobPostings.location),
          ilike(jobPostings.location, '%remote%'),
        );

        // LANDMINE: Drizzle's or() returns undefined when given zero conditions,
        // and an undefined predicate passed into and(...) is silently dropped —
        // which would turn myLocation=true for a keyword-less zone into an
        // *unfiltered whole-table* response. This explicit empty-array branch
        // is what prevents that.
        if (keywords.length === 0) return alwaysIncluded;

        return or(
          alwaysIncluded,
          ...keywords.map((kw) => ilike(jobPostings.location, `%${kw}%`)),
        );
      })()
    : undefined;

  try {
    const rows = await db
      .select()
      .from(jobPostings)
      .where(and(ageFilter, cursorFilter, locationFilter))
      .orderBy(desc(jobPostings.viewCount), desc(jobPostings.id))
      .limit(PAGE_SIZE + 1); // fetch 1 extra to determine hasMore

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.viewCount, last.id) : null;

    res.json({ jobs: page, hasMore, nextCursor });
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch jobs feed');
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

export default router;
