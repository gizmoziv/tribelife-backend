import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  handle: string | null;
  isPremium: boolean;
  timezone: string | null;
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
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: number };

    const result = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        handle: userProfiles.handle,
        isPremium: userProfiles.isPremium,
        timezone: userProfiles.timezone,
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
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? '30d' }
  );
}
