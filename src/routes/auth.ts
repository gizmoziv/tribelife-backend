import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { users, userProfiles } from '../db/schema';
import { signToken, requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Apple Sign-In JWKS for token verification
const appleJWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// ── Google Sign-In ─────────────────────────────────────────────────────────
// The mobile app sends the ID token from expo-auth-session after the user
// completes the Google OAuth flow on-device. We verify it server-side.
const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

router.post('/google', async (req: Request, res: Response): Promise<void> => {
  const parse = googleAuthSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'idToken is required' });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parse.data.idToken,
      audience: [
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_IOS_CLIENT_ID!,
      ],
    });

    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      res.status(400).json({ error: 'Invalid Google token payload' });
      return;
    }

    const { email, name, sub: googleId, picture: avatarUrl } = payload;

    // Look up by googleId first, then email
    let user = await db
      .select()
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(userProfiles.googleId, googleId))
      .limit(1)
      .then((r) => r[0]);

    let isNewUser = false;

    if (!user) {
      // Check if email already exists (webapp user connecting Google)
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing[0]) {
        // Link Google to existing account
        await db
          .update(userProfiles)
          .set({ googleId, avatarUrl: avatarUrl ?? undefined, updatedAt: new Date() })
          .where(eq(userProfiles.userId, existing[0].id));

        user = await db
          .select()
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, existing[0].id))
          .limit(1)
          .then((r) => r[0]);
      } else {
        // Brand new user — create user record (profile created during onboarding)
        const [newUser] = await db
          .insert(users)
          .values({
            email,
            name: name ?? email.split('@')[0],
            passwordHash: null,
          })
          .returning();

        isNewUser = true;
        user = { users: newUser, user_profiles: null } as typeof user;
      }
    }

    if (!user) {
      res.status(500).json({ error: 'Failed to create or fetch user' });
      return;
    }

    const token = signToken(user.users.id);
    const needsOnboarding = !user.user_profiles?.handle;

    res.json({
      token,
      user: {
        id: user.users.id,
        email: user.users.email,
        name: user.users.name,
        handle: user.user_profiles?.handle ?? null,
        avatarUrl: user.user_profiles?.avatarUrl ?? null,
        isPremium: user.user_profiles?.isPremium ?? false,
        timezone: user.user_profiles?.timezone ?? null,
      },
      needsOnboarding,
      isNewUser,
    });
  } catch (err) {
    console.error('[auth/google]', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// ── Sign in with Apple ────────────────────────────────────────────────────
const appleAuthSchema = z.object({
  identityToken: z.string().min(1),
  fullName: z.object({
    givenName: z.string().nullable().optional(),
    familyName: z.string().nullable().optional(),
  }).nullable().optional(),
  email: z.string().email().nullable().optional(),
});

router.post('/apple', async (req: Request, res: Response): Promise<void> => {
  const parse = appleAuthSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'identityToken is required' });
    return;
  }

  try {
    // Verify the identity token with Apple's public keys
    const { payload } = await jwtVerify(parse.data.identityToken, appleJWKS, {
      issuer: 'https://appleid.apple.com',
      audience: process.env.APPLE_BUNDLE_ID!,
    });

    const appleUserId = payload.sub;
    if (!appleUserId) {
      res.status(400).json({ error: 'Invalid Apple token' });
      return;
    }

    // Apple only sends email/name on FIRST sign-in, so we must persist them
    const appleEmail = parse.data.email ?? (payload.email as string | undefined);
    const appleName = [
      parse.data.fullName?.givenName,
      parse.data.fullName?.familyName,
    ].filter(Boolean).join(' ') || null;

    // Look up by appleId first
    let user = await db
      .select()
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(userProfiles.appleId, appleUserId))
      .limit(1)
      .then((r) => r[0]);

    let isNewUser = false;

    if (!user) {
      // Check if email already exists (link Apple to existing account)
      if (appleEmail) {
        const existing = await db
          .select()
          .from(users)
          .where(eq(users.email, appleEmail))
          .limit(1);

        if (existing[0]) {
          await db
            .update(userProfiles)
            .set({ appleId: appleUserId, updatedAt: new Date() })
            .where(eq(userProfiles.userId, existing[0].id));

          user = await db
            .select()
            .from(users)
            .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
            .where(eq(users.id, existing[0].id))
            .limit(1)
            .then((r) => r[0]);
        }
      }

      if (!user) {
        // Brand new user
        const email = appleEmail ?? `apple_${appleUserId}@privaterelay.appleid.com`;
        const name = appleName ?? 'TribeLife User';

        const [newUser] = await db
          .insert(users)
          .values({
            email,
            name,
            passwordHash: null,
          })
          .returning();

        isNewUser = true;
        user = { users: newUser, user_profiles: null } as typeof user;
      }
    }

    if (!user) {
      res.status(500).json({ error: 'Failed to create or fetch user' });
      return;
    }

    const token = signToken(user.users.id);
    const needsOnboarding = !user.user_profiles?.handle;

    res.json({
      token,
      user: {
        id: user.users.id,
        email: user.users.email,
        name: user.users.name,
        handle: user.user_profiles?.handle ?? null,
        avatarUrl: user.user_profiles?.avatarUrl ?? null,
        isPremium: user.user_profiles?.isPremium ?? false,
        timezone: user.user_profiles?.timezone ?? null,
      },
      needsOnboarding,
      isNewUser,
    });
  } catch (err) {
    console.error('[auth/apple]', err);
    res.status(401).json({ error: 'Apple authentication failed' });
  }
});

// ── Onboarding — Set handle + timezone ────────────────────────────────────
const onboardingSchema = z.object({
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, 'Handle can only contain letters, numbers, and underscores'),
  timezone: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Terms of Service to continue' }),
  }),
});

router.post('/onboarding', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = onboardingSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.errors[0].message });
    return;
  }

  const { handle, timezone, avatarUrl } = parse.data;
  const userId = req.user!.id;

  // Check handle uniqueness
  const existing = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.handle, handle.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: 'That handle is already taken' });
    return;
  }

  // Create or update profile
  const [profile] = await db
    .insert(userProfiles)
    .values({
      userId,
      handle: handle.toLowerCase(),
      timezone,
      avatarUrl,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { handle: handle.toLowerCase(), timezone, updatedAt: new Date() },
    })
    .returning();

  res.json({ profile });
});

// ── Check handle availability ──────────────────────────────────────────────
router.get('/handle-check/:handle', async (req: Request, res: Response): Promise<void> => {
  const handle = (req.params.handle as string).toLowerCase();

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(handle)) {
    res.json({ available: false, reason: 'Invalid handle format' });
    return;
  }

  const existing = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.handle, handle))
    .limit(1);

  res.json({ available: existing.length === 0 });
});

// ── Get current user (also refreshes timezone if provided) ────────────────
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const timezone = req.query.timezone as string | undefined;

  if (timezone && timezone !== req.user!.timezone) {
    await db
      .update(userProfiles)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(userProfiles.userId, req.user!.id));

    req.user!.timezone = timezone;
  }

  res.json({ user: req.user });
});

// ── Delete account ────────────────────────────────────────────────────────
router.delete('/account', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;

  try {
    await db.delete(users).where(eq(users.id, userId));
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/delete-account]', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ── Update push token ──────────────────────────────────────────────────────
router.put('/push-token', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { expoPushToken } = req.body;
  if (!expoPushToken) {
    res.status(400).json({ error: 'expoPushToken is required' });
    return;
  }

  await db
    .update(userProfiles)
    .set({ expoPushToken, updatedAt: new Date() })
    .where(eq(userProfiles.userId, req.user!.id));

  res.json({ ok: true });
});

export default router;
