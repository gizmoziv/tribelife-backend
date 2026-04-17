import 'dotenv/config';
import path from 'path';
import express from 'express';
import logger from './lib/logger';

const log = logger.child({ module: 'server' });
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import beaconsRouter from './routes/beacons';
import notificationsRouter from './routes/notifications';
import usersRouter from './routes/users';
import supportRouter from './routes/support';
import revenuecatRouter from './routes/revenuecat';
import moderationRouter from './routes/moderation';
import uploadRouter from './routes/upload';
import globeRouter from './routes/globe';
import newsRouter from './routes/news';
import reactionsRouter from './routes/reactions';
import referralsRouter from './routes/referrals';
import groupsRouter from './routes/groups';
import wellKnownRouter from './routes/wellKnown';
import deepLinkFallbackRouter from './routes/deepLinkFallback';
import { startBeaconMatcherCron } from './jobs/beaconMatcher';
import { startNewsIngesterCron } from './jobs/newsIngester';
import { createSocketServer } from './socket';

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

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api', limiter);

// ── REST Routes ────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/beacons', beaconsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/users', usersRouter);
app.use('/api/support', supportRouter);
app.use('/api/revenuecat', revenuecatRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/globe', globeRouter);
app.use('/api/news', newsRouter);
app.use('/api/reactions', reactionsRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/chat/groups', groupsRouter);

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

// ── Socket.io ─────────────────────────────────────────────────────────────
const io = createSocketServer(httpServer);
app.set('io', io);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4000;

httpServer.listen(PORT, () => {
  log.info({ port: PORT }, 'TribeLife backend running');
  startBeaconMatcherCron();
  startNewsIngesterCron();
});

export { io };
export { logger };
