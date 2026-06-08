/**
 * /api/tribe — Tribe Hub backend routes.
 *
 * Endpoints:
 *   GET  /today      → TodayPayload (parsha + daf + candle-lighting by stored location)
 *   GET  /cities?q=  → [{geonameid, label}] city typeahead via GeoNames proxy
 *   PUT  /location   → persist caller's chosen candle location on user_profiles
 *
 * All routes require authentication (requireAuth).
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { userProfiles, surveys, surveyOptions, surveyVotes } from '../db/schema';
import { and, count, eq, sql } from 'drizzle-orm';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { searchCities } from '../services/tribe/geonames';
import { getToday } from '../services/tribe/todayService';
import { toWireTodayPayload } from '../services/tribe/todayWire';

const router = Router();

// All tribe routes require auth
router.use(requireAuth);

// ── GET /api/tribe/cities ─────────────────────────────────────────────────

const citiesQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters'),
});

/**
 * City typeahead — proxies GeoNames server-side; GEONAMES_USERNAME never
 * returned to the client.
 */
router.get('/cities', async (req: AuthRequest, res): Promise<void> => {
  const parse = citiesQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  try {
    const cities = await searchCities(parse.data.q);
    res.json({ cities });
  } catch (err) {
    console.error('[tribe/cities]', err);
    res.status(503).json({ error: 'City search temporarily unavailable' });
  }
});

// ── PUT /api/tribe/location ───────────────────────────────────────────────

// Accepts EITHER a geonameid (manual pick) OR lat+lon+label (GPS).
// Exactly one form must be present — validated below.
const locationSchema = z
  .object({
    geonameid: z.number().int().positive().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    label: z.string().min(1).max(200).optional(),
    source: z.enum(['manual', 'gps']),
  })
  .refine(
    (d) => {
      const hasGeonameid = d.geonameid !== undefined;
      const hasLatLon = d.lat !== undefined && d.lon !== undefined;
      // Exactly one form
      return hasGeonameid !== hasLatLon;
    },
    { message: 'Provide either geonameid (manual) or lat+lon (gps), not both or neither' },
  );

/**
 * Persist the caller's chosen candle-lighting location.
 * Scoped to the caller's own user_profiles row (IDOR-safe).
 */
router.put('/location', async (req: AuthRequest, res): Promise<void> => {
  const parse = locationSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { geonameid, lat, lon, label, source } = parse.data;

  try {
    if (geonameid !== undefined) {
      // Manual city pick — clear GPS fields
      await db
        .update(userProfiles)
        .set({
          candleGeonameid: geonameid,
          candleLat: null,
          candleLon: null,
          candleLabel: label ?? null,
          candleSource: source,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));
    } else {
      // GPS coordinates — clear geonameid
      await db
        .update(userProfiles)
        .set({
          candleGeonameid: null,
          candleLat: lat!,
          candleLon: lon!,
          candleLabel: label ?? null,
          candleSource: source,
          updatedAt: new Date(),
        })
        .where(eq(userProfiles.userId, userId));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[tribe/location]', err);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

// ── GET /api/tribe/today ─────────────────────────────────────────────────

/**
 * Returns today's parsha (Israel vs Diaspora by timezone), Daf Yomi (global),
 * and candle-lighting times (by stored location, or null + needsLocation=true
 * when no location is stored yet).
 *
 * Parsha and daf always populate regardless of whether a location is stored.
 */
router.get('/today', async (req: AuthRequest, res): Promise<void> => {
  const user = req.user!;

  try {
    const now = new Date();
    const internal = await getToday({
      geonameid: user.candleGeonameid ?? undefined,
      lat: user.candleLat ?? undefined,
      lon: user.candleLon ?? undefined,
      tzid: user.timezone ?? 'UTC',
      nowIso: now.toISOString(),
      label: user.candleLabel ?? undefined,
    });

    const today = await toWireTodayPayload(internal, now);
    // Return the raw payload (NOT enveloped) — mobile tribeApi.today is typed
    // request<TodayPayload> and reads data.shabbat / data.needsLocation directly.
    res.json(today);
  } catch (err) {
    console.error('[tribe/today]', err);
    res.status(503).json({ error: 'Today data temporarily unavailable' });
  }
});

// ── GET /api/tribe/survey ─────────────────────────────────────────────────

/**
 * Returns the active survey with per-option vote counts and the caller's
 * vote state (hasVoted / votedOptionId). Raw Other free-text is never
 * included in this payload (R4/R6 data-exposure boundary).
 */
router.get('/survey', async (req: AuthRequest, res): Promise<void> => {
  try {
    const userId = req.user!.id;

    // Load the active survey (take first/lowest id if multiple)
    const [activeSurvey] = await db
      .select({ id: surveys.id, questionText: surveys.questionText })
      .from(surveys)
      .where(eq(surveys.active, true))
      .orderBy(surveys.id)
      .limit(1);

    if (!activeSurvey) {
      res.json({ survey: null });
      return;
    }

    // Load options ordered by displayOrder
    const options = await db
      .select({
        id: surveyOptions.id,
        label: surveyOptions.label,
        isOther: surveyOptions.isOther,
        displayOrder: surveyOptions.displayOrder,
      })
      .from(surveyOptions)
      .where(eq(surveyOptions.surveyId, activeSurvey.id))
      .orderBy(surveyOptions.displayOrder);

    // Compute per-option vote counts
    const voteCounts = await db
      .select({
        optionId: surveyVotes.optionId,
        total: count(),
      })
      .from(surveyVotes)
      .where(eq(surveyVotes.surveyId, activeSurvey.id))
      .groupBy(surveyVotes.optionId);

    const countByOptionId = new Map<number, number>();
    for (const row of voteCounts) {
      countByOptionId.set(row.optionId, Number(row.total));
    }

    // Determine caller vote state
    const [callerVote] = await db
      .select({ optionId: surveyVotes.optionId })
      .from(surveyVotes)
      .where(
        and(
          eq(surveyVotes.surveyId, activeSurvey.id),
          eq(surveyVotes.userId, userId),
        ),
      )
      .limit(1);

    const hasVoted = callerVote !== undefined;
    const votedOptionId = callerVote?.optionId ?? null;

    res.json({
      survey: {
        id: activeSurvey.id,
        questionText: activeSurvey.questionText,
        options: options.map((opt) => ({
          id: opt.id,
          label: opt.label,
          isOther: opt.isOther,
          displayOrder: opt.displayOrder,
          count: countByOptionId.get(opt.id) ?? 0,
        })),
        hasVoted,
        votedOptionId,
      },
    });
  } catch (err) {
    console.error('[tribe/survey]', err);
    res.status(500).json({ error: 'Failed to load survey' });
  }
});

// ── POST /api/tribe/survey/vote ────────────────────────────────────────────

const voteSchema = z.object({
  optionId: z.number().int().positive(),
  otherText: z.string().optional(),
});

/**
 * Submit a one-time immutable vote. Second submit returns 409 without
 * mutating the stored vote. Selecting the Other option with empty/whitespace
 * otherText returns 400. Caller identity is from JWT (req.user!.id).
 */
router.post('/survey/vote', async (req: AuthRequest, res): Promise<void> => {
  const parse = voteSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const userId = req.user!.id;
  const { optionId, otherText } = parse.data;

  try {
    // Resolve the active survey
    const [activeSurvey] = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(eq(surveys.active, true))
      .orderBy(surveys.id)
      .limit(1);

    if (!activeSurvey) {
      res.status(409).json({ error: 'No active survey' });
      return;
    }

    // Validate optionId belongs to this survey
    const [option] = await db
      .select({ id: surveyOptions.id, isOther: surveyOptions.isOther })
      .from(surveyOptions)
      .where(
        and(
          eq(surveyOptions.id, optionId),
          eq(surveyOptions.surveyId, activeSurvey.id),
        ),
      )
      .limit(1);

    if (!option) {
      res.status(400).json({ error: 'Invalid option' });
      return;
    }

    // Server-side Other re-validation — never trust the client
    if (option.isOther) {
      const trimmed = (otherText ?? '').trim();
      if (!trimmed) {
        res.status(400).json({ error: 'Please tell us your suggestion' });
        return;
      }
    }

    const trimmedOther = option.isOther ? (otherText ?? '').trim() : null;

    // Insert vote; handle duplicate via onConflictDoNothing + zero-rows → 409
    const inserted = await db
      .insert(surveyVotes)
      .values({
        surveyId: activeSurvey.id,
        userId,
        optionId,
        otherText: trimmedOther,
      })
      .onConflictDoNothing()
      .returning({ id: surveyVotes.id });

    if (inserted.length === 0) {
      res.status(409).json({ error: 'Already voted' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[tribe/survey/vote]', err);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

export default router;
