import 'dotenv/config';
import 'express-async-errors';
import path from 'path';
import express from 'express';
import logger from './lib/logger';

const log = logger.child({ module: 'server' });
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp, { type Options as PinoHttpOptions } from 'pino-http';
import crypto from 'crypto';
import type { AuthRequest } from './middleware/auth';
import errorHandler from './middleware/errorHandler';

import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import chatsRouter from './routes/chats';
import beaconsRouter from './routes/beacons';
import notificationsRouter from './routes/notifications';
import usersRouter from './routes/users';
import supportRouter from './routes/support';
import revenuecatRouter from './routes/revenuecat';
import moderationRouter from './routes/moderation';
import adminRouter from './routes/admin';
import uploadRouter from './routes/upload';
import avatarsRouter from './routes/avatars';
import globeRouter from './routes/globe';
import newsRouter from './routes/news';
import tribeRouter from './routes/tribe';
import reactionsRouter from './routes/reactions';
import referralsRouter from './routes/referrals';
import groupsRouter from './routes/groups';
import pinsRouter from './routes/pins';
import jobsRouter from './routes/jobs';
import linkPreviewRouter from './routes/linkPreview';
import orgsRouter from './routes/orgs';
import orgsPublicRouter from './routes/orgsPublic';
import versionRouter from './routes/version';
import wellKnownRouter from './routes/wellKnown';
import deepLinkFallbackRouter from './routes/deepLinkFallback';
import { startBeaconMatcherCron } from './jobs/beaconMatcher';
import { startNewsIngesterCron } from './jobs/newsIngester';
import { startNewsPushRetentionCron } from './jobs/newsPushRetention';
import { startJobsScraperCron } from './jobs/jobsScraper';
import { startAtsFeedsCron } from './jobs/atsFeeds';
import { startAliasReaperCron } from './jobs/aliasReaper';
import { createSocketServer } from './socket';
import { pool } from './db';
import { registerShutdownSignals } from './lib/shutdown';
import { setIO } from './lib/socketRegistry';
import { moderationEnforced } from './lib/moderationEnforcement';

const app = express();
const httpServer = createServer(app);

// ── Middleware ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://www.google-analytics.com", "https://analytics.google.com", "https://region1.google-analytics.com"],
    },
  },
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim());
if (!allowedOrigins || allowedOrigins.length === 0) {
  if (process.env.NODE_ENV === 'production') {
    log.fatal('ALLOWED_ORIGINS not set in production');
    process.exit(1);
  }
  log.warn('ALLOWED_ORIGINS not set -- allowing all origins (dev mode)');
}
app.use(cors({
  origin: allowedOrigins && allowedOrigins.length > 0
    ? (origin, callback) => {
        if (!origin) return callback(null, true); // Allow mobile/native (no Origin header)
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    : true,
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));

// ── HTTP request logging (HARDEN-03) ─────────────────────────────────────
// One structured pino line per HTTP request with method, path, status,
// duration_ms, userId (if authed), ip, userAgent, appVersion, reqId.
// Reuses the root pino logger via a child to keep output unified (D-21).
// genReqId honors upstream x-request-id if present; echoes the id in the
// response header for support-ticket correlation (D-26). The success/error
// object hooks read AuthUser.id from req.user — AuthUser has field `id`,
// NOT `userId` (auth.ts:13).
//
// Why customSuccessObject / customErrorObject instead of customProps:
// pino-http v11 invokes `customProps` TWICE per request — once at request
// start (bound onto req.log as child bindings, when req.user is still
// undefined) and once at response end (merged into the final log call, when
// req.user is populated). The resulting JSON line carried duplicate keys
// (reqId / userId / userAgent each appeared twice, with the first userId
// always null and the second one the real id) — ~30% wasted bytes per line
// and a footgun for naive greps like `"userId":null`. The *Object hooks
// only fire at response time, so the top-level shape HARDEN-03 requires is
// preserved without duplication. (The `reqId` field is still emitted by
// pino-http itself via `genReqId` — no need to re-emit it from our hook.)
function buildLogObject(req: AuthRequest, val: object): object {
  const ua = (req.headers['user-agent'] as string | undefined) ?? null;
  // iOS app UA shape: "TribeLifeApp/<build> CFNetwork/<x> Darwin/<y>".
  // Android/Expo UA does not include this prefix → appVersion stays null.
  const appVersion = ua?.match(/TribeLifeApp\/(\S+)/)?.[1] ?? null;
  return {
    ...val,
    reqId: req.id,
    userId: req.user?.id ?? null,
    userAgent: ua,
    appVersion,
  };
}
app.use(pinoHttp({
  // Cast: pino-http's Options.logger type narrows to the default pino levels
  // ('info' | 'error' | 'warn' | ...), but our root logger is typed as
  // Logger<string>. The runtime behavior is identical (same pino instance,
  // same level set) — the cast only satisfies the TS type-checker.
  // Use the narrowing `PinoHttpOptions['logger']` rather than `as never` so
  // the type-checker still flags future shape mismatches on pino/pino-http
  // upgrades instead of silently succeeding (WR-05).
  logger: logger.child({ module: 'http' }) as PinoHttpOptions['logger'],
  genReqId: (req, res) => {
    const id = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customSuccessObject: (req, _res, val) => buildLogObject(req as AuthRequest, val),
  customErrorObject: (req, _res, _err, val) => buildLogObject(req as AuthRequest, val),
  // HARDEN-03 literal field-name spec: rename pino-http's default response-time
  // key `responseTime` → `duration_ms`. This is REQUIRED (not optional / not
  // contingent on runtime inspection) — the HARDEN-03 spec fixes the field
  // name, and Task 3 strictly asserts `"duration_ms"` presence + `"responseTime"`
  // absence. Note: customAttributeKeys only renames TOP-LEVEL attribute names
  // on the log record (e.g. `responseTime` → `duration_ms`); it does NOT rename
  // the inner fields produced by `serializers.req` / `serializers.res` below.
  // The serializers emit the nested shape `{ req: { method, path, ip },
  // res: { status }, duration_ms }` — assertions that target top-level `path`,
  // `status`, `ip` would fail. Assertions against `req.path` / `res.status` /
  // `req.ip` (nested) will pass. Top-level userId / userAgent / appVersion
  // are added at log time via buildLogObject above.
  customAttributeKeys: {
    responseTime: 'duration_ms',
  },
  customLogLevel: (_req, res, err) =>
    err || res.statusCode >= 500 ? 'error'
    : res.statusCode >= 400 ? 'warn'
    : 'info',
  autoLogging: {
    ignore: (req) =>
      req.url === '/health' ||
      /\.(js|css|png|svg|ico|woff2?|jpg|jpeg|gif|webp)$/i.test(req.url ?? ''),
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      path: req.url,
      ip: req.remoteAddress,
    }),
    res: (res) => ({
      status: res.statusCode,
    }),
  },
}));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api', limiter);

// ── REST Routes ────────────────────────────────────────────────────────────
app.use('/api/version', versionRouter);
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/orgs', orgsPublicRouter); // public reads first (RESEARCH.md Pitfall #1)
app.use('/api/orgs', orgsRouter);
app.use('/api/beacons', beaconsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/users', usersRouter);
app.use('/api/support', supportRouter);
app.use('/api/revenuecat', revenuecatRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/admin', adminRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/avatars', avatarsRouter);
app.use('/api/globe', globeRouter);
app.use('/api/news', newsRouter);
app.use('/api/tribe', tribeRouter);
app.use('/api/reactions', reactionsRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/chat/groups', groupsRouter);
app.use('/api/pins', pinsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/link-preview', linkPreviewRouter);

// ── Resolve public directory for static files ────────────────────────────
const fs = require('fs');
const publicDirPrimary = path.resolve(__dirname, '../public');
const publicDirAlt = path.resolve(process.cwd(), 'public');
const resolvedPublicDir = fs.existsSync(publicDirPrimary) ? publicDirPrimary : publicDirAlt;
log.info({ resolvedPublicDir, publicDirPrimary, publicDirAlt }, 'Static files dir resolved');

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── SEO: Redirect old/dead routes to homepage ────────────────────────────
const deadRoutes = ['/fundraising', '/spaces', '/jobs', '/discussions'];
for (const route of deadRoutes) {
  app.get(route, (_req, res) => res.redirect(301, '/'));
}

// ── SEO: Redirect www to non-www ─────────────────────────────────────────
app.use((req, res, next) => {
  const host = req.hostname;
  if (host.startsWith('www.')) {
    return res.redirect(301, `https://${host.slice(4)}${req.originalUrl}`);
  }
  next();
});

// ── Deep Link Verification & Fallback (MUST be before SPA catch-all) ────
app.use('/.well-known', wellKnownRouter);
app.use(deepLinkFallbackRouter);

// ── Marketing website (SPA) ──────────────────────────────────────────────
app.use(express.static(resolvedPublicDir));
// SPA fallback: serve index.html for non-file, non-API routes
app.get('*', (_req, res, next) => {
  // Skip if the request looks like a file (has an extension)
  if (_req.path.includes('.')) {
    return next();
  }
  res.sendFile(path.join(resolvedPublicDir, 'index.html'));
});

// ── Global error handler (HARDEN-01) ─────────────────────────────────────
// 4-arg Express error middleware — MUST be the final app.use() call. Catches
// uncaught errors from sync AND async route handlers (express-async-errors
// loaded on line 2 propagates async rejections to next(err)). Logs full
// error via pino + returns { error: string } with appropriate status.
app.use(errorHandler);

// ── Boot ───────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  const io = await createSocketServer(httpServer);
  app.set('io', io);
  setIO(io);

  // News-ingester cron schedule is DB-configurable (Phase 2 CONFIG-01) —
  // read news_config.news_ingest_cron_schedule and validate before listen()
  // so an invalid prod value fails fast inside bootstrap().catch below,
  // not after we've started accepting traffic. See D-13.
  const newsIngesterTask = await startNewsIngesterCron();

  const PORT = process.env.PORT ?? 4000;
  httpServer.listen(PORT, () => {
    log.info({ port: PORT }, 'TribeLife backend running');
    if (!moderationEnforced()) {
      log.warn('[moderation] ⚠ ENFORCEMENT DISABLED — SHADOW mode (log-only, no user impact). Set MODERATION_ENFORCEMENT_ENABLED=true to enforce.');
    }
    const beaconMatcherTask = startBeaconMatcherCron();
    const newsPushRetentionTask = startNewsPushRetentionCron();
    const jobsScraperTask = startJobsScraperCron(); // Phase 24 — null unless JOBS_SCRAPER_ENABLED=true (paused pending JewishJobs permission)
    const atsFeedsTask = startAtsFeedsCron(); // Phase 24 — null unless ATS_FEEDS_ENABLED=true (legal Greenhouse/Lever org feeds)
    const aliasReaperTask = startAliasReaperCron(); // daily reap of unused group-slug aliases (30-day TTL)

    // HARDEN-02: register SIGTERM/SIGINT graceful shutdown.
    // MUST be inside the listen() callback — at this moment all resources
    // (io, crons, HTTP accepting) are live. Registering earlier would mean
    // httpServer.close() in the handler runs on a server not yet bound.
    const cronTasks = [newsIngesterTask, beaconMatcherTask, newsPushRetentionTask, aliasReaperTask];
    if (jobsScraperTask) cronTasks.push(jobsScraperTask); // only when the scraper cron is enabled
    if (atsFeedsTask) cronTasks.push(atsFeedsTask); // only when ATS feeds cron is enabled
    registerShutdownSignals({
      httpServer,
      io,
      pool,
      cronTasks,
    });
  });
}

bootstrap().catch((err) => {
  log.fatal({ err }, 'Bootstrap failed');
  process.exit(1);
});
