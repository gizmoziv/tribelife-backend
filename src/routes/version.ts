import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import logger from '../lib/logger';
import { compareVersions } from '../services/version';

const log = logger.child({ module: 'version' });

const router = Router();

// Per D-06: zod validates shape but the handler ALSO fail-opens on parse
// failure. We never 400 — a malformed query would otherwise lock out a
// misbehaving old client. Belt + suspenders: shape-validate AND fall back.
const QuerySchema = z.object({
  platform: z.enum(['ios', 'android']),
  version: z.string().min(1),
});

/**
 * GET /api/version/check?platform=ios|android&version=X.Y.Z
 *
 * Returns one of:
 *   { ok: true }                                                  (at-or-above floor)
 *   { ok: false, reason: 'force_update', minVersion, message? }   (below floor)
 *
 * Per D-10 this endpoint is PUBLIC — no requireAuth / optionalAuth.
 * Per D-01 / D-03 missing env → fail-open (return ok: true).
 */
router.get('/check', async (req: Request, res: Response): Promise<void> => {
  const parse = QuerySchema.safeParse(req.query);
  if (!parse.success) {
    // D-06 fail-open: malformed query → ok:true (NEVER 400 — never lock out
    // a misbehaving old client). Log so the operator can spot oddities.
    log.warn({ query: req.query, err: parse.error.errors[0]?.message }, '[version] malformed query — fail-open');
    res.json({ ok: true });
    return;
  }

  const { platform, version } = parse.data;
  const envKey = platform === 'ios' ? 'MIN_CLIENT_VERSION_IOS' : 'MIN_CLIENT_VERSION_ANDROID';
  // Read at REQUEST time (not module load) so env restart picks up new floors
  // without a code redeploy (D-03).
  const floor = (process.env[envKey] || '').trim() || '0.0.0';

  // compareVersions returns 0 for unparseable input → ok:true (fail-open).
  const cmp = compareVersions(version, floor);
  if (cmp >= 0) {
    res.json({ ok: true });
    return;
  }

  // Optional human-readable message — env-driven, undefined when unset.
  const message = process.env.FORCE_UPDATE_MESSAGE?.trim() || undefined;
  const body: { ok: false; reason: 'force_update'; minVersion: string; message?: string } = {
    ok: false,
    reason: 'force_update',
    minVersion: floor,
  };
  if (message) body.message = message;
  res.json(body);
});

export default router;
