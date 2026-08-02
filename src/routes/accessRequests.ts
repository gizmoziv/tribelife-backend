import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { accessRequests, userProfiles } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { requireAuth, AuthRequest } from '../middleware/auth';

// ── Zod schemas (module-scope constants, safeParse-only validation,
// first-error-message-only — project convention) ──────────────────────────

// D-08: platformOther is required only when platform === 'other'. .superRefine
// is this repo's established pattern for a field required only when a sibling
// field has a specific value (see auth.ts deletionFeedbackSchema, pins.ts).
const socialEntrySchema = z
  .object({
    platform: z.enum(['linkedin', 'instagram', 'facebook', 'other']),
    platformOther: z.string().trim().min(1).max(50).optional(),
    handle: z.string().trim().min(1).max(100),
  })
  .superRefine((data, ctx) => {
    if (data.platform === 'other' && !data.platformOther) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'platformOther is required when platform is other',
        path: ['platformOther'],
      });
    }
  });

const accessRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  socials: z.array(socialEntrySchema).min(1, 'At least one social link is required'),
});

const router = Router();

// Deliberately NOT gated by the post-auth approval-status middleware
// (D-17 carve-out). This is the gated user's only exit path — gating it
// would make the `pending` state permanent and unescapable (34-RESEARCH.md
// Pitfall 1). Do not add that gate here when 34-04's rollout mounts it
// elsewhere.
router.use(requireAuth);

// ── Submit an access request (D-08, D-09, D-24) ───────────────────────────
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = accessRequestSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }
  const userId = req.user!.id;

  // D-24: one access request per user, no resubmission — checked before any
  // write. This response is deliberately specific (NOT subject to D-06's
  // anti-enumeration rule) because it only ever reveals the caller's own
  // state. The appeal channel for a rejected user is email (Phase 35's
  // locked copy), not resubmission — allowing it would create duplicate rows
  // the admin queue would have to de-duplicate and hand a rejected user an
  // unlimited retry loop.
  const [existing] = await db
    .select({ id: accessRequests.id, status: accessRequests.status })
    .from(accessRequests)
    .where(
      and(
        eq(accessRequests.userId, userId),
        inArray(accessRequests.status, ['pending', 'rejected']),
      ),
    )
    .limit(1);

  if (existing) {
    res.status(409).json({
      error: 'An access request already exists for this account.',
      code: 'access_request_exists',
      status: existing.status,
    });
    return;
  }

  // D-09: insert the row. decidedAt/decidedBy stay NULL until an admin
  // decides. No email is stored — the applicant's email is their existing
  // users.email, read by the admin list endpoint via join (D-02).
  const [created] = await db.insert(accessRequests)
    .values({
      userId,
      reason: parse.data.reason,
      socials: parse.data.socials,
      status: 'pending',
    })
    .returning({
      id: accessRequests.id,
      status: accessRequests.status,
      createdAt: accessRequests.createdAt,
    });

  // D-09: flip the caller's own gate status — this is what makes the
  // post-auth approval-status middleware and the socket handshake gate
  // start firing for this user.
  await db
    .update(userProfiles)
    .set({ accessStatus: 'pending', updatedAt: new Date() })
    .where(eq(userProfiles.userId, userId));

  console.log('[access-request]', { userId, requestId: created.id });

  res.json({ ok: true, accessRequest: created });
});

export default router;
