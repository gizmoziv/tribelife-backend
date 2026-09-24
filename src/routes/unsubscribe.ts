// Email marketing unsubscribe — RFC 8058 one-click endpoint (contract section 5b),
// Marketing-Hub/.planning/phases/11-email-marketing/TRIBELIFE-CONTRACT.md.
//
// ⛔ DELIBERATE EXCEPTION to this repo's normal error-handling convention
// (`{ error: string }` + differentiated status codes, see project CLAUDE.md
// "Error Handling"): every outcome here — valid token, wrong-key token,
// tampered token, unknown user id, missing `t`, missing/malformed secret,
// database error — falls through to the exact same 200 response. This is
// mandated by the contract (section 3 rule 6, section 5b): distinguishing
// failure reasons by status, body, redirect, or a caller-visible log line
// creates a user-enumeration oracle. Do NOT "fix" this back to the normal
// convention.
//
// This route is deliberately UNAUTHENTICATED — no requireAuth, no AuthRequest.
// The token itself is the sole authorization credential (contract section 3).
import { Router, Request, Response } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { decryptToken, loadUnsubscribeKey } from '../lib/unsubscribeToken';
import { db } from '../db';
import { userProfiles } from '../db/schema';
import logger from '../lib/logger';

const log = logger.child({ module: 'unsubscribe' });
const router = Router();

const GENERIC_RESPONSE = { ok: true } as const;

// Per-IP, layered on top of the existing global `/api` limiter (120/min,
// server.ts). Satisfies contract section 5b's "rate limited (per IP)".
const unsubscribeLimiter = rateLimit({ windowMs: 60_000, max: 20 });

router.post(
  '/',
  unsubscribeLimiter,
  // Route-scoped ONLY — mail providers POST `List-Unsubscribe=One-Click` as
  // application/x-www-form-urlencoded, but the app registers only
  // express.json() globally. Do NOT add this to server.ts globally — that
  // would change body parsing for every other route.
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Read INSIDE the handler, on every request — never at module scope.
      // This is what keeps a missing/malformed secret from crashing boot
      // (contract section 2); a bad value just makes loadUnsubscribeKey
      // return null, which falls through to the same generic response.
      const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
      const key = loadUnsubscribeKey(secret);
      if (key !== null) {
        // req.body is informational only per RFC 8058 — never branched on.
        // The token comes from req.query.t and nowhere else.
        const userId = decryptToken(req.query.t, key);
        if (userId !== null) {
          await db.update(userProfiles)
            .set({ acceptsEmailMarketing: false })
            .where(eq(userProfiles.userId, userId));
        }
      }
      log.info('unsubscribe request processed');
    } catch {
      // Swallow — never distinguish failure reasons (contract section 3 rule 6).
    }
    res.status(200).json(GENERIC_RESPONSE);
  },
);

// A GET must NEVER mutate — link-preview services, corporate mail gateways
// and security scanners prefetch every URL in an email (contract section 5b).
router.get('/', (_req: Request, res: Response): void => {
  res.status(200).json(GENERIC_RESPONSE);
});

export default router;
