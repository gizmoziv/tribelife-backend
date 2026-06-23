import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

/** Detect platform from User-Agent header */
function detectPlatform(ua: string): 'ios' | 'android' | 'web' {
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'web';
}

/** App store URLs (single source of truth). */
function storeUrls(): { ios: string; android: string } {
  const appStoreId = process.env.APPLE_APP_STORE_ID;
  return {
    ios: appStoreId
      ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
      : 'https://tribelife.app',
    android: 'https://play.google.com/store/apps/details?id=com.tribelife.app',
  };
}

// ── Web (desktop / non-mobile UA) landing page ──────────────────────────────
// Rendered for the `platform === 'web'` branch of the /u and /g deep links so
// that copy-pasting a share link into a browser shows a real "get the app"
// page instead of falling through to the SPA catch-all, which has no /u or /g
// route and renders its NotFound (the reported 404). Includes OG/Twitter meta
// so the same links unfurl with a rich preview when shared. Inputs are already
// sanitized by the callers to [a-zA-Z0-9_-], so no further HTML-escaping is
// required for interpolation here.
function renderDownloadLanding(opts: {
  canonicalUrl: string;
  heading: string;
  subtext: string;
}): string {
  const { canonicalUrl, heading, subtext } = opts;
  const { ios, android } = storeUrls();
  const ogImage = 'https://tribelife.app/android-chrome-512x512.png';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading}</title>
<meta name="description" content="${subtext}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${heading}" />
<meta property="og:description" content="${subtext}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${heading}" />
<meta name="twitter:description" content="${subtext}" />
<meta name="twitter:image" content="${ogImage}" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0 20px; }
  /* Official-style store badges — mirrors web/src/components/landing/StoreBadge.tsx */
  .badges { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .store-badge { display: inline-flex; align-items: center; gap: 12px; background: #000; color: #fff; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 10px 22px; min-width: 180px; text-decoration: none; transition: transform 0.15s ease; }
  .store-badge:hover { transform: scale(1.04); }
  .store-badge svg { flex: 0 0 auto; }
  .store-badge .label { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
  .store-badge .top { font-size: 10px; opacity: 0.9; }
  .store-badge .top.upper { text-transform: uppercase; letter-spacing: 0.5px; }
  .store-badge .bottom { font-size: 18px; font-weight: 600; letter-spacing: -0.2px; }
  .hint { font-size: 13px; opacity: 0.55; margin-top: 18px; }
  /* Animated beacon flame — CSS port of HeroFlameIcon (mobile beacon/index.tsx).
     RN Animated flicker/sway/embers become CSS keyframes; per-layer fill-box
     origin (bottom-center) mirrors each layer's scaleY base origin. */
  .flame { display: flex; justify-content: center; margin-bottom: 6px; }
  .flame-icon { width: 72px; height: 94px; overflow: visible; }
  .fl-sway { transform-box: fill-box; transform-origin: 50% 100%; animation: fl-sway 2.8s ease-in-out infinite; }
  .fl-layer { transform-box: fill-box; transform-origin: 50% 100%; }
  .fl-halo { animation: fl-halo 3.2s ease-in-out infinite; }
  .fl-wisp { animation: fl-wisp 1.24s ease-in-out infinite; }
  .fl-outer { animation: fl-outer 1.56s ease-in-out infinite; }
  .fl-mid { animation: fl-mid 1.04s ease-in-out infinite; }
  .fl-inner { animation: fl-inner 0.68s ease-in-out infinite; }
  .fl-core { animation: fl-core 0.44s ease-in-out infinite; }
  .ember.e1 { animation: ember 1.8s ease-out infinite; }
  .ember.e2 { animation: ember 2.1s ease-out 0.5s infinite; }
  .ember.e3 { animation: ember 1.6s ease-out 0.9s infinite; }
  .ember.e4 { animation: ember 2.4s ease-out 1.3s infinite; }
  @keyframes fl-core { 0%,100% { transform: scaleY(0.88); } 50% { transform: scaleY(1.18); } }
  @keyframes fl-inner { 0%,100% { transform: scaleY(0.92); } 50% { transform: scaleY(1.12); } }
  @keyframes fl-mid { 0%,100% { transform: scaleY(0.95); } 50% { transform: scaleY(1.08); } }
  @keyframes fl-outer { 0%,100% { transform: scaleY(0.97); } 50% { transform: scaleY(1.05); } }
  @keyframes fl-wisp { 0%,100% { transform: scaleY(0.8); } 50% { transform: scaleY(1.2); } }
  @keyframes fl-halo { 0%,100% { opacity: 0.55; } 50% { opacity: 0.95; } }
  @keyframes fl-sway { 0%,100% { transform: rotate(-3.4deg); } 50% { transform: rotate(3.4deg); } }
  @keyframes ember { 0% { transform: translateY(0); opacity: 0; } 30% { opacity: 1; } 100% { transform: translateY(-58px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .fl-sway, .fl-layer, .fl-halo, .ember { animation: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="flame" aria-hidden="true">
    <svg class="flame-icon" viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg" fill="none">
      <defs>
        <radialGradient id="halo" cx="50%" cy="78%" r="55%">
          <stop offset="0" stop-color="#F59E0B" stop-opacity="0.55"/>
          <stop offset="0.6" stop-color="#F97316" stop-opacity="0.15"/>
          <stop offset="1" stop-color="#F97316" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="flameOuter" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stop-color="#F97316" stop-opacity="0.9"/>
          <stop offset="0.6" stop-color="#EF4444" stop-opacity="0.95"/>
          <stop offset="1" stop-color="#B91C1C" stop-opacity="0.85"/>
        </linearGradient>
        <linearGradient id="flameMid" x1="0.5" y1="0.1" x2="0.5" y2="1">
          <stop offset="0" stop-color="#FDE68A" stop-opacity="0.9"/>
          <stop offset="0.5" stop-color="#F59E0B" stop-opacity="0.98"/>
          <stop offset="1" stop-color="#EA580C" stop-opacity="0.95"/>
        </linearGradient>
        <linearGradient id="flameInner" x1="0.5" y1="0.2" x2="0.5" y2="1">
          <stop offset="0" stop-color="#FEF3C7" stop-opacity="1"/>
          <stop offset="0.7" stop-color="#FBBF24" stop-opacity="1"/>
          <stop offset="1" stop-color="#F59E0B" stop-opacity="0.95"/>
        </linearGradient>
        <linearGradient id="flameCore" x1="0.5" y1="0.3" x2="0.5" y2="1">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/>
          <stop offset="0.6" stop-color="#FEF3C7" stop-opacity="1"/>
          <stop offset="1" stop-color="#FDE68A" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <g class="fl-sway">
        <ellipse class="fl-halo" cx="50" cy="92" rx="44" ry="30" fill="url(#halo)"/>
        <g class="fl-layer fl-wisp"><path d="M 22 82 C 12 78 10 68 16 64 C 22 68 24 76 22 82 Z" fill="url(#flameMid)" opacity="0.9"/></g>
        <g class="fl-layer fl-outer"><path d="M 50 108 C 32 108 20 98 18 82 C 14 68 20 56 30 50 C 20 38 26 22 38 18 C 44 8 58 8 60 20 C 66 12 76 18 72 32 C 82 36 86 58 82 76 C 80 98 72 108 50 108 Z" fill="url(#flameOuter)" opacity="0.9"/></g>
        <g class="fl-layer fl-mid"><path d="M 52 100 C 40 100 32 92 30 80 C 28 68 32 58 40 52 C 32 42 38 28 46 26 C 50 20 60 22 60 32 C 66 26 72 34 68 44 C 74 52 76 68 72 80 C 70 94 62 100 52 100 Z" fill="url(#flameMid)"/></g>
        <g class="fl-layer fl-inner"><path d="M 54 92 C 46 92 42 84 42 76 C 42 66 46 58 50 52 C 46 44 50 34 56 32 C 60 30 64 34 62 42 C 66 46 68 58 66 68 C 64 84 62 92 54 92 Z" fill="url(#flameInner)"/></g>
        <g class="fl-layer fl-core"><path d="M 56 54 C 52 58 50 64 52 70 C 54 74 60 72 60 66 C 60 60 60 56 56 54 Z" fill="url(#flameCore)"/></g>
        <g class="ember e1"><circle cx="36" cy="72" r="1.8" fill="#FDE68A"/></g>
        <g class="ember e2"><circle cx="62" cy="66" r="2.2" fill="#F59E0B"/></g>
        <g class="ember e3"><circle cx="50" cy="58" r="1.5" fill="#FFFFFF"/></g>
        <g class="ember e4"><circle cx="44" cy="78" r="1.3" fill="#FDE68A"/></g>
      </g>
    </svg>
  </div>
  <h1>${heading}</h1>
  <p>${subtext}</p>
  <div class="badges">
    <a class="store-badge" href="${ios}" aria-label="Download on the App Store">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
      <span class="label"><span class="top">Download on the</span><span class="bottom">App Store</span></span>
    </a>
    <a class="store-badge" href="${android}" aria-label="Get it on Google Play">
      <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 3.269v17.462a1 1 0 0 0 1.514.857l8.043-4.65-2.828-2.829L3 3.269z" fill="#00D2FF"/><path d="M20.485 10.513 17.1 8.6l-3.372 3.372 3.372 3.37 3.414-1.97a1 1 0 0 0 0-1.859z" fill="#00F076"/><path d="M13.729 11.972 4.514 2.757A1 1 0 0 0 3 3.27l6.9 9.703 3.829-1z" fill="#FFCE00"/><path d="M9.9 13.027 3 22.73a1 1 0 0 0 1.514.857l9.215-5.322-3.829-3.238z" fill="#FF3A44"/></svg>
      <span class="label"><span class="top upper">Get it on</span><span class="bottom">Google Play</span></span>
    </a>
  </div>
  <p class="hint">Already have TribeLife? Open this link on your phone.</p>
</div>
</body>
</html>`;
}

// ── Invite deep link interstitial ─────────────────────────────────────────
// Mobile: writes the referral code to the clipboard so a fresh install can
// recover it. Renders two manual buttons — "Open in TribeLife" (re-fires
// Universal Links / Android Intent) and "Download" (store fallback). The
// previous auto-redirect to App Store via setTimeout fought iOS Universal
// Links (Safari's tab doesn't reliably go `hidden` after UL handoff, so the
// store was opening on top of the launched app).
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
  // "Open in TribeLife" target — ANDROID ONLY. The intent:// URL carries a
  // browser_fallback_url so it opens the app if present, else the Play Store
  // (no error). iOS is intentionally excluded: the custom `tribelife://` scheme
  // throws "the address is invalid" in Safari when the app isn't installed and
  // there's no reliable way to detect installation, so on iOS we drop the
  // "Open" button entirely and make Download the single primary CTA.
  const openInAppHref = platform === 'android'
    ? `intent://tribelife.app/invite${ref ? `?ref=${encodeURIComponent(ref)}` : ''}#Intent;scheme=https;package=com.tribelife.app;S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`
    : '';
  // Platform-conditional button set. iOS: single primary Download. Android:
  // primary "Open in TribeLife" (intent://) + secondary Download.
  const buttonsHtml = platform === 'android'
    ? `  <a class="btn btn-primary" data-clip href="${openInAppHref}">Open in TribeLife</a>
  <a class="btn btn-secondary" data-clip href="${storeUrl}">Download</a>`
    : `  <a class="btn btn-primary" data-clip href="${storeUrl}">Download</a>`;
  const clipboardPayload = ref ? `tribelife-ref:${ref}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open TribeLife</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0 20px; }
  .btn { display: inline-block; margin: 6px 0; padding: 12px 24px; text-decoration: none; border-radius: 999px; font-weight: 600; min-width: 200px; }
  .btn-primary { background: #E8922F; color: #fff; }
  .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); }
</style>
</head>
<body>
<div class="wrap">
  <h1>You're invited to TribeLife</h1>
  <p>Choose how to continue.</p>
${buttonsHtml}
</div>
<script>
(function () {
  var clipboardPayload = ${JSON.stringify(clipboardPayload)};
  function writeClip() {
    if (clipboardPayload && navigator.clipboard && navigator.clipboard.writeText) {
      try { navigator.clipboard.writeText(clipboardPayload).catch(function () {}); } catch (e) {}
    }
  }
  // iOS Safari blocks clipboard writes that aren't tied to a user gesture, so the
  // old on-load write silently failed there and the referral code never reached a
  // fresh install (attribution lost). Bind the write to the button taps (a transient
  // user activation iOS accepts); still attempt on load for Android / browsers that allow it.
  writeClip();
  var btns = document.querySelectorAll('[data-clip]');
  for (var i = 0; i < btns.length; i++) { btns[i].addEventListener('click', writeClip); }
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

  // Sanitize slug (defence-in-depth; Express already URL-decodes :slug)
  const rawSlug = String(req.params.slug ?? '');
  const safeSlug = rawSlug.replace(/[^a-zA-Z0-9-_]/g, '');

  if (platform === 'web') {
    // Web (desktop / non-mobile UA): render the "get the app" landing instead of
    // falling through to the routeless SPA (which would 404). This is the
    // copy-paste-into-a-browser path users hit when a phone share link is opened
    // outside the app.
    return res.type('html').send(
      renderDownloadLanding({
        canonicalUrl: `https://tribelife.app/g/${safeSlug}`,
        heading: 'Join this group on TribeLife',
        subtext:
          'TribeLife is a mobile app — download it on your phone to join the conversation.',
      }),
    );
  }

  // Phase 13: optional ?ref=<handle> attribution token. Same sanitizer as
  // the /invite handler — strips ALL chars outside [a-zA-Z0-9_-] before
  // reflection into HTML / deep link / clipboard payload (defence-in-depth
  // against XSS via reflected query string).
  const rawRef = req.query.ref;
  const safeRef = typeof rawRef === 'string' ? rawRef.replace(/[^a-zA-Z0-9_-]/g, '') : '';

  const appStoreId = process.env.APPLE_APP_STORE_ID;
  const iosStoreUrl = appStoreId
    ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
    : 'https://tribelife.app';
  const androidStoreUrl = 'https://play.google.com/store/apps/details?id=com.tribelife.app';
  const storeUrl = platform === 'ios' ? iosStoreUrl : androidStoreUrl;
  const refQuery = safeRef ? `?ref=${encodeURIComponent(safeRef)}` : '';
  // "Open in TribeLife" target — ANDROID ONLY. iOS is intentionally excluded:
  // the custom `tribelife://` scheme throws "the address is invalid" in Safari
  // when the app isn't installed, so on iOS we drop the "Open" button and make
  // Download the single primary CTA. Android's intent:// has a
  // browser_fallback_url, so it opens the app if present, else the Play Store.
  const openInAppHref = platform === 'android'
    ? `intent://tribelife.app/g/${safeSlug}${refQuery}#Intent;scheme=https;package=com.tribelife.app;S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`
    : '';
  // Platform-conditional button set. iOS: single primary Download. Android:
  // primary "Open in TribeLife" (intent://) + secondary Download.
  const buttonsHtml = platform === 'android'
    ? `  <a class="btn btn-primary" data-clip href="${openInAppHref}">Open in TribeLife</a>
  <a class="btn btn-secondary" data-clip href="${storeUrl}">Download</a>`
    : `  <a class="btn btn-primary" data-clip href="${storeUrl}">Download</a>`;
  // Clipboard payload format: tribelife-g-ref:<ref>:<slug>. Empty when no
  // ref present so the inline <script> branch becomes a no-op.
  const clipboardPayload = safeRef ? `tribelife-g-ref:${safeRef}:${safeSlug}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open TribeLife</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0 20px; }
  .btn { display: inline-block; margin: 6px 0; padding: 12px 24px; text-decoration: none; border-radius: 999px; font-weight: 600; min-width: 200px; }
  .btn-primary { background: #E8922F; color: #fff; }
  .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); }
</style>
</head>
<body>
<div class="wrap">
  <h1>You're invited to a TribeLife group</h1>
  <p>Choose how to continue.</p>
${buttonsHtml}
</div>
<script>
(function () {
  var clipboardPayload = ${JSON.stringify(clipboardPayload)};
  function writeClip() {
    if (clipboardPayload && navigator.clipboard && navigator.clipboard.writeText) {
      try { navigator.clipboard.writeText(clipboardPayload).catch(function () {}); } catch (e) {}
    }
  }
  // Phase 13: write the attribution payload (group slug + inviter handle) so a fresh
  // install can recover it. iOS Safari blocks clipboard writes without a user gesture,
  // so the prior on-load write silently failed there and attribution was lost — bind it
  // to the button taps; still attempt on load for Android / browsers that allow it.
  writeClip();
  var btns = document.querySelectorAll('[data-clip]');
  for (var i = 0; i < btns.length; i++) { btns[i].addEventListener('click', writeClip); }
})();
</script>
</body>
</html>`;

  res.type('html').send(html);
});

// ── Profile share deep link interstitial ───────────────────────────────────
// Phase 13 / ATTR-02: mirrors /g/:slug shape for /u/:handle profile shares.
// Mobile gets the interstitial + clipboard recovery payload (tribelife-u-ref:);
// web falls through to the SPA catch-all so desktop profile views render
// the React profile page unchanged.
router.get('/u/:handle', (req: Request, res: Response, next: NextFunction) => {
  const ua = req.headers['user-agent'] || '';
  const platform = detectPlatform(ua);

  // Sanitize handle (defence-in-depth; Express already URL-decodes :handle)
  const rawHandle = String(req.params.handle ?? '');
  const safeHandle = rawHandle.replace(/[^a-zA-Z0-9_-]/g, '');

  if (platform === 'web') {
    // Web (desktop / non-mobile UA): render the "get the app" landing instead of
    // falling through to the routeless SPA (which would 404). This is the
    // copy-paste-into-a-browser path.
    return res.type('html').send(
      renderDownloadLanding({
        canonicalUrl: `https://tribelife.app/u/${safeHandle}`,
        heading: 'View this profile on TribeLife',
        subtext:
          'TribeLife is a mobile app — download it on your phone to see this profile and connect.',
      }),
    );
  }

  // Phase 13: optional ?ref=<handle> attribution token. Same sanitizer as
  // /invite and /g/:slug — strips ALL chars outside [a-zA-Z0-9_-] before
  // reflection (XSS defence-in-depth).
  const rawRef = req.query.ref;
  const safeRef = typeof rawRef === 'string' ? rawRef.replace(/[^a-zA-Z0-9_-]/g, '') : '';

  const appStoreId = process.env.APPLE_APP_STORE_ID;
  const iosStoreUrl = appStoreId
    ? `https://apps.apple.com/app/tribelife/id${appStoreId}`
    : 'https://tribelife.app';
  const androidStoreUrl = 'https://play.google.com/store/apps/details?id=com.tribelife.app';
  const storeUrl = platform === 'ios' ? iosStoreUrl : androidStoreUrl;
  const refQuery = safeRef ? `?ref=${encodeURIComponent(safeRef)}` : '';
  // "Open in TribeLife" target — ANDROID ONLY. iOS is intentionally excluded:
  // the custom `tribelife://` scheme throws "the address is invalid" in Safari
  // when the app isn't installed (the reported `tribelife:///sagie` error), so
  // on iOS we drop the "Open" button and make Download the single primary CTA.
  // Android's intent:// has a browser_fallback_url, so it opens the app if
  // present, else the Play Store.
  const openInAppHref = platform === 'android'
    ? `intent://tribelife.app/u/${safeHandle}${refQuery}#Intent;scheme=https;package=com.tribelife.app;S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`
    : '';
  // Platform-conditional button set. iOS: single primary Download. Android:
  // primary "Open in TribeLife" (intent://) + secondary Download.
  const buttonsHtml = platform === 'android'
    ? `  <a class="btn btn-primary" data-clip href="${openInAppHref}">Open in TribeLife</a>
  <a class="btn btn-secondary" data-clip href="${storeUrl}">Download</a>`
    : `  <a class="btn btn-primary" data-clip href="${storeUrl}">Download</a>`;
  // Clipboard payload format: tribelife-u-ref:<ref>:<handle>.
  const clipboardPayload = safeRef ? `tribelife-u-ref:${safeRef}:${safeHandle}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Open TribeLife</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #fff; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 15px; opacity: 0.8; margin: 4px 0 20px; }
  .btn { display: inline-block; margin: 6px 0; padding: 12px 24px; text-decoration: none; border-radius: 999px; font-weight: 600; min-width: 200px; }
  .btn-primary { background: #E8922F; color: #fff; }
  .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); }
</style>
</head>
<body>
<div class="wrap">
  <h1>View this profile on TribeLife</h1>
  <p>Choose how to continue.</p>
${buttonsHtml}
</div>
<script>
(function () {
  var clipboardPayload = ${JSON.stringify(clipboardPayload)};
  function writeClip() {
    if (clipboardPayload && navigator.clipboard && navigator.clipboard.writeText) {
      try { navigator.clipboard.writeText(clipboardPayload).catch(function () {}); } catch (e) {}
    }
  }
  // Phase 13: write the attribution payload (profile handle + inviter handle) so a fresh
  // install can recover it. iOS Safari blocks clipboard writes without a user gesture, so
  // the prior on-load write silently failed there and attribution was lost — bind it to the
  // button taps; still attempt on load for Android / browsers that allow it.
  writeClip();
  var btns = document.querySelectorAll('[data-clip]');
  for (var i = 0; i < btns.length; i++) { btns[i].addEventListener('click', writeClip); }
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
