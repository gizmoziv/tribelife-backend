import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

/** Detect platform from User-Agent header */
function detectPlatform(ua: string): 'ios' | 'android' | 'web' {
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'web';
}

// ── Invite deep link interstitial ─────────────────────────────────────────
// Mobile: tries custom scheme to open app if installed, writes ref to clipboard
// so the app can recover it after a fresh install from the store. Falls back
// to the platform-appropriate store.
// Web: redirects to landing page with ref preserved for attribution.
router.get('/invite', (req: Request, res: Response) => {
  const ua = req.headers['user-agent'] || '';
  const platform = detectPlatform(ua);
  const rawRef = req.query.ref;
  const ref = typeof rawRef === 'string' ? rawRef.replace(/[^a-zA-Z0-9_-]/g, '') : '';

  if (platform === 'web') {
    return res.redirect(302, ref ? `/?ref=${encodeURIComponent(ref)}` : '/');
  }

  const appStoreId = process.env.APPLE_APP_STORE_ID;
  const iosStoreUrl = appStoreId
    ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
    : 'https://tribelife.app';
  const androidStoreUrl = `https://play.google.com/store/apps/details?id=com.tribelife.app${ref ? `&referrer=${encodeURIComponent(`ref=${ref}`)}` : ''}`;
  const storeUrl = platform === 'ios' ? iosStoreUrl : androidStoreUrl;
  const deepLink = `tribelife://invite${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const clipboardPayload = ref ? `tribelife-ref:${ref}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Opening TribeLife…</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0; }
  a { display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E8922F; color: #fff; text-decoration: none; border-radius: 999px; font-weight: 600; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Opening TribeLife…</h1>
  <p>If nothing happens, tap the button below.</p>
  <a id="fallback" href="${storeUrl}">Get the App</a>
</div>
<script>
(function () {
  var deepLink = ${JSON.stringify(deepLink)};
  var storeUrl = ${JSON.stringify(storeUrl)};
  var clipboardPayload = ${JSON.stringify(clipboardPayload)};
  var timeout;

  // Write referral code to clipboard so the app can recover it after a fresh install
  if (clipboardPayload && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(clipboardPayload).catch(function () { /* user denied */ });
  }

  // Try opening the app via custom scheme
  window.location.href = deepLink;

  // If the page is still visible after 1500ms, the app isn't installed
  timeout = setTimeout(function () {
    if (!document.hidden) {
      window.location.href = storeUrl;
    }
  }, 1500);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timeout);
  });
})();
</script>
</body>
</html>`;

  res.type('html').send(html);
});

// ── Group invite deep link interstitial ────────────────────────────────────
// Tries to open the app via custom scheme; falls back to the appropriate store.
// This is a permanent safety net under iOS Universal Links / Android App Links
// for users without the app installed, old app versions, or in-app browsers.
router.get('/g/:slug', (req: Request, res: Response, next: NextFunction) => {
  const ua = req.headers['user-agent'] || '';
  const platform = detectPlatform(ua);

  if (platform === 'web') {
    // Web: fall through to SPA catch-all
    return next();
  }

  // Sanitize slug (defence-in-depth; Express already URL-decodes :slug)
  const rawSlug = String(req.params.slug ?? '');
  const safeSlug = rawSlug.replace(/[^a-zA-Z0-9-_]/g, '');

  const appStoreId = process.env.APPLE_APP_STORE_ID;
  const iosStoreUrl = appStoreId
    ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
    : 'https://tribelife.app';
  const androidStoreUrl = 'https://play.google.com/store/apps/details?id=com.tribelife.app';
  const storeUrl = platform === 'ios' ? iosStoreUrl : androidStoreUrl;
  // Three slashes = empty authority. Without this, iOS/Expo Router parses
  // `g` as the URL host, leaving `/${slug}` as the path — which doesn't
  // match the `app/g/[slug].tsx` route and renders +not-found.
  const deepLink = `tribelife:///g/${safeSlug}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Opening TribeLife…</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0; }
  a { display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E8922F; color: #fff; text-decoration: none; border-radius: 999px; font-weight: 600; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Opening TribeLife…</h1>
  <p>If nothing happens, tap the button below.</p>
  <a id="fallback" href="${storeUrl}">Get the App</a>
</div>
<script>
(function () {
  var deepLink = ${JSON.stringify(deepLink)};
  var storeUrl = ${JSON.stringify(storeUrl)};
  var timeout;

  // Try opening the app immediately
  window.location.href = deepLink;

  // If the page is still visible after 1500ms, the app isn't installed
  timeout = setTimeout(function () {
    if (!document.hidden) {
      window.location.href = storeUrl;
    }
  }, 1500);

  // If the app opens, the page goes to background — cancel the store redirect
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timeout);
  });
})();
</script>
</body>
</html>`;

  res.type('html').send(html);
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
