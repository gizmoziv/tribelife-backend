import { Router } from 'express';

const router = Router();

// ── Apple App Site Association (iOS Universal Links) ────────────────────────
router.get('/apple-app-site-association', (_req, res) => {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) {
    console.error('[well-known] APPLE_TEAM_ID not set');
    res.status(503).json({ error: 'AASA not configured' });
    return;
  }

  const aasa = {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.com.tribelife.app`],
          components: [
            {
              '/': '/globe/*',
              comment: 'Globe room deep links',
            },
          ],
        },
      ],
    },
  };

  res.type('application/json').json(aasa);
});

// ── Android Asset Links ─────────────────────────────────────────────────────
router.get('/assetlinks.json', (_req, res) => {
  const sha256 = process.env.ANDROID_SHA256_FINGERPRINT;
  if (!sha256) {
    console.error('[well-known] ANDROID_SHA256_FINGERPRINT not set');
    res.status(503).json({ error: 'Asset links not configured' });
    return;
  }

  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.tribelife.app',
        sha256_cert_fingerprints: [sha256],
      },
    },
  ];

  res.type('application/json').json(assetlinks);
});

export default router;
