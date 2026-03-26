import { Router } from 'express';

const router = Router();

// ── Apple App Site Association (iOS Universal Links) ────────────────────────
// TODO: Replace <APPLE_TEAM_ID> with your Apple Team ID from developer.apple.com
router.get('/apple-app-site-association', (_req, res) => {
  const aasa = {
    applinks: {
      details: [
        {
          appIDs: ['<APPLE_TEAM_ID>.com.tribelife.app'],
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
// TODO: Replace <SHA256_FINGERPRINT> -- run: eas credentials -p android
router.get('/assetlinks.json', (_req, res) => {
  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.tribelife.app',
        sha256_cert_fingerprints: ['<SHA256_FINGERPRINT>'],
      },
    },
  ];

  res.type('application/json').json(assetlinks);
});

export default router;
