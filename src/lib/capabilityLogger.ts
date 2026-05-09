/**
 * Shared capability denial logger.
 *
 * Emits the canonical `[capabilities] denied` pino warn line used by both
 * the `requireCapability` middleware (boolean feature gates) and the
 * `enforceLimit` helper (numeric limit gates). Centralising the call site
 * keeps the structured-field shape locked to D-10 (Phase 3 CONTEXT) and
 * satisfies ENFORCE-04.
 *
 * The log includes ONLY the structured fields enumerated in D-10:
 *   module, userId, route, capability, currentTier, reason, current?, max?
 * Never logs request payload, header values, JWTs, or any PII beyond the
 * numeric userId.
 */
import logger from './logger';
import type { AuthRequest } from '../middleware/auth';
import type { Tier } from '../types/capabilities';

export interface CapabilityDenialContext {
  req: AuthRequest;
  capability: string;
  currentTier: Tier;
  reason: 'feature' | 'limit';
  current?: number;
  max?: number;
}

export function logCapabilityDenial(ctx: CapabilityDenialContext): void {
  const { req, capability, currentTier, reason, current, max } = ctx;
  const route = req.method + ' ' + (req.route?.path ?? req.path);
  logger.warn(
    {
      module: 'capabilities',
      userId: req.user!.id,
      route,
      capability,
      currentTier,
      reason,
      ...(current !== undefined ? { current } : {}),
      ...(max !== undefined ? { max } : {}),
    },
    '[capabilities] denied'
  );
}
