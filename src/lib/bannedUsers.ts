import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';

// Returns true when the given user has an active admin ban (users.bannedAt IS NOT NULL).
export async function isUserBanned(userId: number): Promise<boolean> {
  const result = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.bannedAt)))
    .limit(1);

  return result.length > 0;
}
