import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

/** Detect platform from User-Agent header */
function detectPlatform(ua: string): 'ios' | 'android' | 'web' {
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'web';
}

// ── Invite deep link fallback ──────────────────────────────────────────────
router.get('/invite', (req: Request, res: Response, next: NextFunction) => {
  const ua = req.headers['user-agent'] || '';
  const platform = detectPlatform(ua);

  if (platform === 'ios') {
    const appStoreId = process.env.APPLE_APP_STORE_ID;
    const storeUrl = appStoreId
      ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
      : 'https://tribelife.app';
    return res.redirect(302, storeUrl);
  }

  if (platform === 'android') {
    return res.redirect(302, 'https://play.google.com/store/apps/details?id=com.tribelife.app');
  }

  next();
});

// ── Globe deep link fallback ────────────────────────────────────────────────
// Redirects mobile users to app stores; web users fall through to SPA catch-all.
// TODO: Replace <APP_STORE_ID> with your App Store numeric ID
router.get('/globe/*', (req: Request, res: Response, next: NextFunction) => {
  const ua = req.headers['user-agent'] || '';
  const platform = detectPlatform(ua);

  if (platform === 'ios') {
    const appStoreId = process.env.APPLE_APP_STORE_ID;
    const storeUrl = appStoreId
      ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
      : 'https://tribelife.app';
    return res.redirect(302, storeUrl);
  }

  if (platform === 'android') {
    return res.redirect(302, 'https://play.google.com/store/apps/details?id=com.tribelife.app');
  }

  // Web: fall through to SPA catch-all
  next();
});

export default router;
