/**
 * Capability enforcement middleware factory.
 *
 * Provides:
 *   - getCapabilities(req)       — async per-request memoizer (D-02). Mirrors
 *                                  the canonical /api/auth/capabilities path
 *                                  (auth.ts:597-604): fetch org memberships,
 *                                  call computeCapabilities, return.
 *                                  Memoized onto req._capabilities so multiple
 *                                  gates in one request don't re-fetch.
 *   - requireCapability(check)   — Express middleware factory with a TS
 *                                  function-overload signature (D-01). String
 *                                  key for the 95% boolean-feature case;
 *                                  predicate as escape hatch for compound
 *                                  rules. On denial: logs via
 *                                  logCapabilityDenial then responds
 *                                  403 { error, capabilityViolation: true }.
 *   - CapabilityViolationError   — typed exception used by Plan 03-02
 *                                  enforceLimit; co-located with the
 *                                  middleware that converts it to a 403.
 *
 * Satisfies ENFORCE-01: caps are recomputed from req.user + a live
 * org-membership read on every gated request — no token claims, no
 * cross-request cache.
 */
import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthRequest } from './auth';
import type { Capabilities, CapabilityFeatures, Tier } from '../types/capabilities';
import { computeCapabilities } from '../services/capabilities';
import { getOrgMembershipsForUser } from '../services/orgMemberships';
import { logCapabilityDenial } from '../lib/capabilityLogger';

// Module augmentation so `req._capabilities` is typed without `any`.
// The memo is request-scoped — it dies when the request ends.
declare module 'express-serve-static-core' {
  interface Request {
    _capabilities?: Capabilities;
  }
}

/**
 * Resolve the capabilities for the current request, memoized per-request.
 * Mirrors the /api/auth/capabilities route (auth.ts:597-604) — calls
 * `getOrgMembershipsForUser` then `computeCapabilities` with the same args.
 *
 * MUST be called only after `requireAuth` has populated `req.user`.
 */
export async function getCapabilities(req: AuthRequest): Promise<Capabilities> {
  if (req._capabilities) return req._capabilities;
  const orgMemberships = await getOrgMembershipsForUser(req.user!.id);
  const caps = computeCapabilities({
    isPremium: req.user!.isPremium,
    premiumExpiresAt: req.user!.premiumExpiresAt,
    orgMemberships,
  });
  req._capabilities = caps;
  return caps;
}

/**
 * Typed exception for capability violations. Plan 03-02 `enforceLimit`
 * throws this; routes catch it and respond with the same 403 shape this
 * middleware emits. Co-located here so the rejection contract lives in
 * one file.
 */
export class CapabilityViolationError extends Error {
  readonly capability: string;
  readonly tier: Tier;
  readonly current?: number;
  readonly max?: number;

  constructor(args: {
    capability: string;
    tier: Tier;
    message: string;
    current?: number;
    max?: number;
  }) {
    super(args.message);
    this.name = 'CapabilityViolationError';
    this.capability = args.capability;
    this.tier = args.tier;
    this.current = args.current;
    this.max = args.max;
  }
}

// ── requireCapability: TS function overloads (D-01) ───────────────────────
// Two public signatures share one implementation. Do NOT collapse to a
// union-typed body branch — overloads make calls greppable and let TS
// narrow the call site.

export function requireCapability(
  check: keyof CapabilityFeatures,
  errorMsg?: string
): RequestHandler;
export function requireCapability(
  check: (caps: Capabilities) => boolean,
  errorMsg?: string
): RequestHandler;
export function requireCapability(
  check: keyof CapabilityFeatures | ((caps: Capabilities) => boolean),
  errorMsg?: string
): RequestHandler {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const caps = await getCapabilities(req);
    let allowed: boolean;
    let capabilityLabel: string;
    if (typeof check === 'string') {
      allowed = caps.features[check] === true;
      capabilityLabel = check;
    } else {
      allowed = check(caps) === true;
      capabilityLabel = 'predicate';
    }
    if (!allowed) {
      logCapabilityDenial({
        req,
        capability: capabilityLabel,
        currentTier: caps.tier,
        reason: 'feature',
      });
      res.status(403).json({
        error: errorMsg ?? 'Premium feature',
        capabilityViolation: true,
      });
      return;
    }
    next();
  };
}
