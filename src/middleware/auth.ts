import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import { eq } from 'drizzle-orm';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  isPremium: boolean;
  premiumExpiresAt: Date | null;
  timezone: string | null;
  acceptedTermsAt: Date | null;
  handleUpdatedAt: Date | null;
}

export const HANDLE_COOLDOWN_DAYS = 30;
export const HANDLE_COOLDOWN_MS = HANDLE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export function needsOnboarding(user: Pick<AuthUser, 'handle' | 'acceptedTermsAt'>): boolean {
  if (!user.handle) return true;
  if (user.handle.startsWith('_temp_')) return true;
  if (!user.acceptedTermsAt) return true;
  return false;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };

    const result = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        handle: userProfiles.handle,
        avatarUrl: userProfiles.avatarUrl,
        isPremium: userProfiles.isPremium,
        premiumExpiresAt: userProfiles.premiumExpiresAt,
        timezone: userProfiles.timezone,
        acceptedTermsAt: userProfiles.acceptedTermsAt,
        handleUpdatedAt: userProfiles.handleUpdatedAt,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!result[0]) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = result[0] as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function signToken(userId: number): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN ?? '30d') as any;
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn });
}
