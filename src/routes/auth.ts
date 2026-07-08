import { Router, Request, Response } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'auth' });
import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { eq, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  users,
  userProfiles,
  referrals,
  messages,
  globeRoomMemberships,
} from '../db/schema';
import {
  signToken,
  requireAuth,
  needsOnboarding,
  HANDLE_COOLDOWN_DAYS,
  HANDLE_COOLDOWN_MS,
  ACCOUNT_SUSPENDED_MESSAGE,
  AuthRequest,
} from '../middleware/auth';
import { computeCapabilities } from '../services/capabilities';
import { getOrgMembershipsForUser } from '../services/orgMemberships';
import { bootstrapAutoJoins } from '../services/globeMembership';
import { getZoneForTimezone } from '../config/timezoneZones';
import { callerCanAccessNonNativeTimezone } from '../lib/timezoneRoomAccess';
import { sendWelcomeEmail } from '../services/email';
import { getIO } from '../lib/socketRegistry';
import { logUserEvent } from '../services/userEvents';

const router = Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Free-premium days granted to a net-new joiner who provides a valid referrer (REF-06)
const joinerPremiumDays = parseInt(
  process.env.REFERRAL_JOINER_PREMIUM_DAYS || '14',
  10,
);

// Apple Sign-In JWKS for token verification
const appleJWKS = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
);

// ── Google Sign-In ─────────────────────────────────────────────────────────
// The mobile app sends the ID token from expo-auth-session after the user
// completes the Google OAuth flow on-device. We verify it server-side.
const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

router.post('/google', async (req: Request, res: Response): Promise<void> => {
  log.info(
    { hasBody: !!req.body, bodyKeys: req.body ? Object.keys(req.body) : [] },
    'google-signin endpoint hit',
  );
  const parse = googleAuthSchema.safeParse(req.body);
  if (!parse.success) {
    log.warn(
      { error: parse.error.errors[0]?.message },
      'google-signin validation failed',
    );
    res.status(400).json({ error: 'idToken is required' });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parse.data.idToken,
      audience: [
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_IOS_CLIENT_ID!,
        process.env.GOOGLE_ANDROID_CLIENT_ID!,
        process.env.GOOGLE_LEGACY_CLIENT_ID!,
        process.env.GOOGLE_LEGACY_IOS_CLIENT_ID!,
      ].filter(Boolean) as string[],
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
          .set({
            googleId,
            avatarUrl: avatarUrl ?? undefined,
            updatedAt: new Date(),
          })
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

        // Create skeleton profile so foreign-key dependents work before onboarding
        const tempHandle = `_temp_${newUser.id}`;
        await db
          .insert(userProfiles)
          .values({
            userId: newUser.id,
            handle: tempHandle,
            googleId,
            avatarUrl: avatarUrl ?? undefined,
          })
          .onConflictDoNothing();

        const freshUser = await db
          .select()
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, newUser.id))
          .limit(1)
          .then((r) => r[0]);
        user =
          freshUser ?? ({ users: newUser, user_profiles: null } as typeof user);
        await bootstrapAutoJoins(newUser.id);
      }
    }

    if (!user) {
      res.status(500).json({ error: 'Failed to create or fetch user' });
      return;
    }

    // Platform ban: block re-entry. The account row is kept (not deleted) so the
    // unique google_id stays claimed — this is what stops a banned user from
    // signing back in with the same Google account and minting a fresh session.
    if (user.users.bannedAt) {
      res
        .status(403)
        .json({ error: ACCOUNT_SUSPENDED_MESSAGE, code: 'account_suspended' });
      return;
    }

    await bootstrapAutoJoins(user.users.id);
    const token = signToken(user.users.id);
    const profile = user.user_profiles;
    const userId = user.users.id;

    const orgMemberships = await getOrgMembershipsForUser(user.users.id);
    // isPremium removed from response payload (TIER-03); the field below is the
    // backend-internal input to computeCapabilities — not a response field.
    const premiumFlag = profile?.isPremium ?? false;
    const capabilities = computeCapabilities({
      isPremium: premiumFlag,
      premiumExpiresAt: profile?.premiumExpiresAt ?? null,
      orgMemberships,
      isStaff: user.users.isStaff,
    });

    const [referralInfo] = await db
      .select({ source: referrals.source, referrerHandle: userProfiles.handle })
      .from(referrals)
      .leftJoin(userProfiles, eq(userProfiles.userId, referrals.referrerId))
      .where(eq(referrals.referredUserId, userId))
      .limit(1);
    const referralSource = referralInfo?.source ?? null;
    const referrerHandle = referralInfo?.referrerHandle ?? null;

    res.json({
      token,
      user: {
        id: user.users.id,
        email: user.users.email,
        name: user.users.name,
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // isPremium removed (TIER-03) — consumers read capabilities.isPremium
        timezone: profile?.timezone ?? null,
        timezoneZone: getZoneForTimezone(profile?.timezone ?? 'UTC'),
        acceptedTermsAt: profile?.acceptedTermsAt ?? null,
        handleUpdatedAt: profile?.handleUpdatedAt ?? null,
        bio: profile?.bio ?? null,
        referralSource,
        referrerHandle,
      },
      needsOnboarding: needsOnboarding({
        handle: profile?.handle ?? null,
        acceptedTermsAt: profile?.acceptedTermsAt ?? null,
      }),
      isNewUser,
      capabilities,
    });

    // AUDIT-01: record the login (fire-and-forget; never blocks the response).
    void logUserEvent(userId, 'login', { provider: 'google', isNewUser });
  } catch (err) {
    log.error({ err }, 'Google authentication failed');
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// ── Sign in with Apple ────────────────────────────────────────────────────
const appleAuthSchema = z.object({
  identityToken: z.string().min(1),
  fullName: z
    .object({
      givenName: z.string().nullable().optional(),
      familyName: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
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
    const appleEmail =
      parse.data.email ?? (payload.email as string | undefined);
    const appleName =
      [parse.data.fullName?.givenName, parse.data.fullName?.familyName]
        .filter(Boolean)
        .join(' ') || null;

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
        const email =
          appleEmail ?? `apple_${appleUserId}@privaterelay.appleid.com`;
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

        // Create skeleton profile so foreign-key dependents work before onboarding
        const tempHandle = `_temp_${newUser.id}`;
        await db
          .insert(userProfiles)
          .values({
            userId: newUser.id,
            handle: tempHandle,
            appleId: appleUserId,
          })
          .onConflictDoNothing();

        const freshUser = await db
          .select()
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, newUser.id))
          .limit(1)
          .then((r) => r[0]);
        user =
          freshUser ?? ({ users: newUser, user_profiles: null } as typeof user);
        await bootstrapAutoJoins(newUser.id);
      }
    }

    if (!user) {
      res.status(500).json({ error: 'Failed to create or fetch user' });
      return;
    }

    // Platform ban: block re-entry. The account row is kept (not deleted) so the
    // unique apple_id stays claimed — this is what stops a banned user from
    // signing back in with the same Apple account and minting a fresh session.
    if (user.users.bannedAt) {
      res
        .status(403)
        .json({ error: ACCOUNT_SUSPENDED_MESSAGE, code: 'account_suspended' });
      return;
    }

    await bootstrapAutoJoins(user.users.id);
    const token = signToken(user.users.id);
    const profile = user.user_profiles;
    const userId = user.users.id;

    const orgMemberships = await getOrgMembershipsForUser(user.users.id);
    // isPremium removed from response payload (TIER-03); the field below is the
    // backend-internal input to computeCapabilities — not a response field.
    const premiumFlag = profile?.isPremium ?? false;
    const capabilities = computeCapabilities({
      isPremium: premiumFlag,
      premiumExpiresAt: profile?.premiumExpiresAt ?? null,
      orgMemberships,
      isStaff: user.users.isStaff,
    });

    const [referralInfo] = await db
      .select({ source: referrals.source, referrerHandle: userProfiles.handle })
      .from(referrals)
      .leftJoin(userProfiles, eq(userProfiles.userId, referrals.referrerId))
      .where(eq(referrals.referredUserId, userId))
      .limit(1);
    const referralSource = referralInfo?.source ?? null;
    const referrerHandle = referralInfo?.referrerHandle ?? null;

    res.json({
      token,
      user: {
        id: user.users.id,
        email: user.users.email,
        name: user.users.name,
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // isPremium removed (TIER-03) — consumers read capabilities.isPremium
        timezone: profile?.timezone ?? null,
        timezoneZone: getZoneForTimezone(profile?.timezone ?? 'UTC'),
        acceptedTermsAt: profile?.acceptedTermsAt ?? null,
        handleUpdatedAt: profile?.handleUpdatedAt ?? null,
        bio: profile?.bio ?? null,
        referralSource,
        referrerHandle,
      },
      needsOnboarding: needsOnboarding({
        handle: profile?.handle ?? null,
        acceptedTermsAt: profile?.acceptedTermsAt ?? null,
      }),
      isNewUser,
      capabilities,
    });

    // AUDIT-01: record the login (fire-and-forget; never blocks the response).
    void logUserEvent(userId, 'login', { provider: 'apple', isNewUser });
  } catch (err) {
    log.error({ err }, 'Apple authentication failed');
    res.status(401).json({ error: 'Apple authentication failed' });
  }
});

// ── Onboarding — Set handle + timezone ────────────────────────────────────
const onboardingSchema = z.object({
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Handle can only contain letters, numbers, and underscores',
    ),
  timezone: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({
      message: 'You must accept the Terms of Service to continue',
    }),
  }),
  referralCode: z.string().max(50).optional(),
  attributionSource: z
    .enum(['handle_code', 'profile_share', 'group_invite', 'manual_entry'])
    .optional(),
});

router.post(
  '/onboarding',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parse = onboardingSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    const { handle, timezone, avatarUrl, referralCode, attributionSource } =
      parse.data;
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

    // Detect first-time onboarding vs handle change. On signup we create a
    // skeleton profile with handle "_temp_<id>" so FKs work, then flip it to
    // the real handle on the first /onboarding call. Any subsequent call to
    // this endpoint (should be rare — mobile guards it via needsOnboarding)
    // won't trigger a second welcome email.
    const [priorProfile] = await db
      .select({ handle: userProfiles.handle })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    const isFirstOnboarding =
      !priorProfile || priorProfile.handle.startsWith('_temp_');

    // Create or update profile — acceptedTermsAt is stamped here because the
    // mobile onboarding form requires the terms checkbox before it calls this.
    const acceptedTermsAt = new Date();
    const [profile] = await db
      .insert(userProfiles)
      .values({
        userId,
        handle: handle.toLowerCase(),
        timezone,
        avatarUrl,
        acceptedTermsAt,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          handle: handle.toLowerCase(),
          timezone,
          acceptedTermsAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Track referral if code provided
    if (referralCode) {
      // Join users table to also fetch bannedAt so we can exclude banned referrers (REF-09)
      const [referrer] = await db
        .select({ userId: userProfiles.userId, bannedAt: users.bannedAt })
        .from(userProfiles)
        .innerJoin(users, eq(users.id, userProfiles.userId))
        .where(eq(userProfiles.handle, referralCode.toLowerCase()))
        .limit(1);

      // Valid referrer: exists, is a different user, and is not banned (REF-09)
      const isValidReferrer =
        referrer != null &&
        referrer.userId !== userId &&
        referrer.bannedAt === null;

      if (isValidReferrer) {
        await db.insert(referrals).values({
          referrerId: referrer.userId,
          referredUserId: userId,
          referralCode: referralCode.toLowerCase(),
          status: 'onboarded',
          convertedAt: new Date(),
          source: attributionSource ?? 'handle_code',
        });

        console.log('[attribution]', {
          userId,
          referrerId: referrer.userId,
          source: attributionSource ?? 'handle_code',
        });

        // Grant referrer premium: 1 referral = 1 month, cap at 12 (REF-07 — unchanged)
        const [countResult] = await db
          .select({ total: count() })
          .from(referrals)
          .where(eq(referrals.referrerId, referrer.userId));

        const totalReferrals = Math.min(countResult?.total ?? 0, 12);
        if (totalReferrals > 0) {
          const premiumExpiry = new Date();
          premiumExpiry.setMonth(premiumExpiry.getMonth() + totalReferrals);
          await db
            .update(userProfiles)
            .set({
              isPremium: true,
              premiumExpiresAt: premiumExpiry,
              updatedAt: new Date(),
            })
            .where(eq(userProfiles.userId, referrer.userId));
        }

        // Grant joiner premium — net-new users only (REF-06)
        // Predicate mirrors capabilities.ts: isPremium && (premiumExpiresAt === null || premiumExpiresAt > now)
        const now = new Date();
        const joinerHasActivePremium =
          profile.isPremium &&
          (profile.premiumExpiresAt === null || profile.premiumExpiresAt > now);

        if (isFirstOnboarding && !joinerHasActivePremium) {
          const premiumExpiry = new Date(
            Date.now() + joinerPremiumDays * 86400000,
          );
          const grantedAt = new Date();
          await db
            .update(userProfiles)
            .set({
              isPremium: true,
              premiumExpiresAt: premiumExpiry,
              updatedAt: grantedAt,
            })
            .where(eq(userProfiles.userId, userId));
          // Sync in-memory profile so res.json({ profile }) reflects the grant
          profile.isPremium = true;
          profile.premiumExpiresAt = premiumExpiry;
          profile.updatedAt = grantedAt;
          console.log('[attribution] joiner premium granted', {
            userId,
            referrerId: referrer.userId,
            days: joinerPremiumDays,
          });
        }
      } else {
        // Referral miss: code was supplied but did not resolve to a valid different non-banned referrer (REF-09, REF-04)
        log.warn(
          {
            attemptedHandle: referralCode.toLowerCase(),
            source: attributionSource ?? null,
            userId,
          },
          '[attribution] referral miss',
        );
      }
    }

    // Fire-and-forget welcome email. We intentionally do not await — email
    // delivery is not on the critical path of onboarding, and a SendGrid
    // outage must never block a user from finishing signup.
    if (isFirstOnboarding && req.user!.email) {
      sendWelcomeEmail({
        toEmail: req.user!.email,
        name: req.user!.name ?? '',
        handle: handle.toLowerCase(),
      }).catch((err) =>
        log.error({ err: err?.message, userId }, 'welcome email failed'),
      );
    }

    // Announce the new user in their timezone room. Persisted with kind='system'
    // so it shows up in scrollback for users who weren't connected at the moment
    // of onboarding (WhatsApp/Slack pattern). senderId is the new user so the
    // existing leftJoin in chat.ts hydrates handle+avatar, and the literal
    // "@handle" in the body keeps the link tappable via mention parsing on the
    // mobile bubble even if the account is later deleted.
    if (isFirstOnboarding) {
      try {
        // Phase 15 (D-01): system messages land in the consolidated zone room
        // (e.g. timezone:eastern-time), NOT the raw IANA room. NY + Detroit +
        // Toronto onboardings all post to the same eastern-time history.
        const timezoneRoom = `timezone:${getZoneForTimezone(timezone)}`;
        const lowerHandle = handle.toLowerCase();
        const announcementContent = `@${lowerHandle} joined the chat`;

        const [systemMsg] = await db
          .insert(messages)
          .values({
            content: announcementContent,
            senderId: userId,
            roomId: timezoneRoom,
            kind: 'system',
            mentions: [userId],
          })
          .returning();

        const io = getIO();
        if (io) {
          io.to(timezoneRoom).emit('room:message', {
            id: systemMsg.id,
            content: announcementContent,
            senderId: userId,
            senderHandle: lowerHandle,
            senderAvatar: profile?.avatarUrl ?? null,
            roomId: timezoneRoom,
            createdAt: systemMsg.createdAt,
            kind: 'system',
            mentions: [userId],
            replyToId: null,
            replyTo: null,
          });
        }
      } catch (err) {
        log.error({ err, userId }, 'system join-message broadcast failed');
      }
    }

    res.json({ profile });
  },
);

// ── Check handle availability ──────────────────────────────────────────────
router.get(
  '/handle-check/:handle',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
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
  },
);

// ── Update handle (rate-limited: once every 30 days) ──────────────────────
const updateHandleSchema = z.object({
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-zA-Z0-9_]+$/,
      'Handle can only contain letters, numbers, and underscores',
    ),
});

router.put(
  '/handle',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parse = updateHandleSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    const userId = req.user!.id;
    const newHandle = parse.data.handle.toLowerCase();
    const now = new Date();

    // Cooldown check — only enforced if the user has changed it before.
    // The initial handle set during onboarding does NOT start the clock; the
    // first edit is free.
    const lastChangedAt = req.user!.handleUpdatedAt;
    if (lastChangedAt) {
      const elapsed = now.getTime() - new Date(lastChangedAt).getTime();
      if (elapsed < HANDLE_COOLDOWN_MS) {
        const nextChangeAt = new Date(
          new Date(lastChangedAt).getTime() + HANDLE_COOLDOWN_MS,
        );
        res.status(429).json({
          error: `You can only change your handle once every ${HANDLE_COOLDOWN_DAYS} days.`,
          nextChangeAt: nextChangeAt.toISOString(),
        });
        return;
      }
    }

    // No-op if the handle hasn't actually changed.
    if (newHandle === req.user!.handle) {
      res
        .status(400)
        .json({ error: 'New handle is the same as your current handle.' });
      return;
    }

    // Uniqueness check (excluding the user's own row to be safe).
    const existing = await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.handle, newHandle))
      .limit(1);

    if (existing[0] && existing[0].userId !== userId) {
      res.status(409).json({ error: 'That handle is already taken' });
      return;
    }

    await db
      .update(userProfiles)
      .set({ handle: newHandle, handleUpdatedAt: now, updatedAt: now })
      .where(eq(userProfiles.userId, userId));

    const nextChangeAt = new Date(now.getTime() + HANDLE_COOLDOWN_MS);
    res.json({
      handle: newHandle,
      handleUpdatedAt: now.toISOString(),
      nextChangeAt: nextChangeAt.toISOString(),
    });
  },
);

// ── Get current user (also refreshes timezone if provided) ────────────────
router.get(
  '/me',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const timezone = req.query.timezone as string | undefined;

    if (timezone && timezone !== req.user!.timezone) {
      const oldTimezone = req.user!.timezone;

      await db
        .update(userProfiles)
        .set({ timezone, updatedAt: new Date() })
        .where(eq(userProfiles.userId, req.user!.id));

      req.user!.timezone = timezone;

      // Phase 15 D-06 / D-07: handle old native zone on timezone change.
      // D-06: premium/org_admin — preserve old native as a non-native membership
      //       row so the user's chat history in their old zone stays accessible.
      // D-07: free user — silent drop (NO auto-conversion). Otherwise a free
      //       caller could harvest non-native memberships by spinning profile-tz
      //       around the world. This preserves the capability boundary.
      // Capability snapshot uses the caller's PRE-CHANGE caps — correct per
      // CONTEXT.md §domain bullet 7. (Tier doesn't change on tz change anyway,
      // so pre/post snapshots are identical in practice; explicit
      // `computeCapabilities` call keeps the audit semantic visible.)
      if (oldTimezone) {
        const oldZoneSlug = getZoneForTimezone(oldTimezone);
        const newZoneSlug = getZoneForTimezone(timezone);

        if (oldZoneSlug !== newZoneSlug && oldZoneSlug !== 'utc') {
          const orgMemberships = await getOrgMembershipsForUser(req.user!.id);
          const caps = computeCapabilities({
            isPremium: req.user!.isPremium,
            premiumExpiresAt: req.user!.premiumExpiresAt,
            orgMemberships,
            isStaff: req.user!.isStaff,
          });

          if (callerCanAccessNonNativeTimezone(caps)) {
            await db
              .insert(globeRoomMemberships)
              .values({ userId: req.user!.id, roomSlug: oldZoneSlug })
              .onConflictDoNothing({
                target: [
                  globeRoomMemberships.userId,
                  globeRoomMemberships.roomSlug,
                ],
              });
            console.log(
              '[tzroom tz-change] userId=' +
                req.user!.id +
                ' verdict=preserved old=' +
                oldZoneSlug +
                ' new=' +
                newZoneSlug +
                ' tier=' +
                caps.tier,
            );
          } else {
            console.log(
              '[tzroom tz-change] userId=' +
                req.user!.id +
                ' verdict=dropped-free old=' +
                oldZoneSlug +
                ' new=' +
                newZoneSlug,
            );
          }
        }
      }
    }

    const orgMemberships = await getOrgMembershipsForUser(req.user!.id);
    const userPremium = req.user!.isPremium;
    const capabilities = computeCapabilities({
      isPremium: userPremium,
      premiumExpiresAt: req.user!.premiumExpiresAt,
      orgMemberships,
      isStaff: req.user!.isStaff,
    });

    const [referralInfo] = await db
      .select({ source: referrals.source, referrerHandle: userProfiles.handle })
      .from(referrals)
      .leftJoin(userProfiles, eq(userProfiles.userId, referrals.referrerId))
      .where(eq(referrals.referredUserId, req.user!.id))
      .limit(1);
    const referralSource = referralInfo?.source ?? null;
    const referrerHandle = referralInfo?.referrerHandle ?? null;

    res.json({
      user: {
        id: req.user!.id,
        email: req.user!.email,
        name: req.user!.name,
        handle: req.user!.handle,
        avatarUrl: req.user!.avatarUrl,
        // isPremium deliberately omitted (TIER-03) — consumers read capabilities.isPremium
        timezone: req.user!.timezone,
        timezoneZone: getZoneForTimezone(req.user!.timezone ?? 'UTC'),
        acceptedTermsAt: req.user!.acceptedTermsAt,
        handleUpdatedAt: req.user!.handleUpdatedAt,
        bio: req.user!.bio ?? null,
        referralSource,
        referrerHandle,
      },
      needsOnboarding: needsOnboarding(req.user!),
      capabilities,
    });
  },
);

// ── Update bio ─────────────────────────────────────────────────────────────
const updateBioSchema = z.object({ bio: z.string().max(280).nullable() });

router.put(
  '/me/bio',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parse = updateBioSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.errors[0].message });
      return;
    }

    const userId = req.user!.id;
    const raw = parse.data.bio;
    const next = raw === null ? null : raw.trim() === '' ? null : raw.trim();

    try {
      await db
        .update(userProfiles)
        .set({ bio: next, updatedAt: new Date() })
        .where(eq(userProfiles.userId, userId));
      res.json({ bio: next });
    } catch (err) {
      log.error({ err, userId }, 'bio update failed');
      res.status(500).json({ error: 'Failed to update bio' });
    }
  },
);

// ── Get current capabilities (foreground refresh) ─────────────────────
router.get(
  '/capabilities',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const orgMemberships = await getOrgMembershipsForUser(req.user!.id);
    const userPremium = req.user!.isPremium;
    const capabilities = computeCapabilities({
      isPremium: userPremium,
      premiumExpiresAt: req.user!.premiumExpiresAt,
      orgMemberships,
      isStaff: req.user!.isStaff,
    });
    res.json({ capabilities });
  },
);

// ── Delete account ────────────────────────────────────────────────────────
router.delete(
  '/account',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    log.info({ userId }, 'request to delete their account');
    try {
      await db.delete(users).where(eq(users.id, userId));
      // AUDIT-01: record the deletion untethered (user_id null) — the row must
      // not point at the person we just deleted. Fire-and-forget.
      void logUserEvent(null, 'account_deleted');
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Failed to delete account');
      res.status(500).json({ error: 'Failed to delete account' });
    }
  },
);

// ── Update push token ──────────────────────────────────────────────────────
router.put(
  '/push-token',
  requireAuth,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const handle = req.user!.handle;
    const { expoPushToken } = req.body;

    log.info(
      {
        userId,
        handle,
        hasToken: !!expoPushToken,
        tokenPrefix:
          typeof expoPushToken === 'string' ? expoPushToken.slice(0, 20) : null,
      },
      'push-token endpoint hit',
    );

    if (!expoPushToken) {
      log.warn({ userId, handle }, 'push-token request missing expoPushToken');
      res.status(400).json({ error: 'expoPushToken is required' });
      return;
    }

    try {
      const result = await db
        .update(userProfiles)
        .set({ expoPushToken, updatedAt: new Date() })
        .where(eq(userProfiles.userId, userId))
        .returning({ userId: userProfiles.userId });

      log.info(
        { userId, handle, rowsUpdated: result.length },
        'push-token stored',
      );
      res.json({ ok: true });
    } catch (err) {
      log.error({ err, userId, handle }, 'push-token update failed');
      res.status(500).json({ error: 'Failed to update push token' });
    }
  },
);

export default router;
