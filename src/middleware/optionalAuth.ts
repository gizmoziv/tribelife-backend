import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { loadAuthUser, type AuthRequest } from './auth';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Optional authentication. Sets req.user when a valid bearer token is provided.
 * Calls next() without 401 when:
 *   - No Authorization header
 *   - Header is malformed
 *   - Token is invalid or expired
 *   - User row not found
 * Used by orgsPublic.ts so anonymous visitors can read the public org page.
 *
 * Shares the loadAuthUser helper with requireAuth — single source of truth
 * for the users + user_profiles join.
 */
export const optionalAuth = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
    if (!decoded?.userId) return next();

    const user = await loadAuthUser(decoded.userId);
    if (user) {
      req.user = user;
    }
    return next();
  } catch {
    // Silent fall-through — invalid/expired token = anonymous request, NOT 401
    return next();
  }
};
