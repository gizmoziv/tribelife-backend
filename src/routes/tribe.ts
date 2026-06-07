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
import { userProfiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { searchCities } from '../services/tribe/geonames';
import { getToday } from '../services/tribe/todayService';

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
    const today = await getToday({
      geonameid: user.candleGeonameid ?? undefined,
      lat: user.candleLat ?? undefined,
      lon: user.candleLon ?? undefined,
      tzid: user.timezone ?? 'UTC',
      nowIso: new Date().toISOString(),
    });

    res.json({ today });
  } catch (err) {
    console.error('[tribe/today]', err);
    res.status(503).json({ error: 'Today data temporarily unavailable' });
  }
});

export default router;
