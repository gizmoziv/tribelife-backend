import { Router } from 'express';
import logger from '../lib/logger';

const log = logger.child({ module: 'well-known' });

const router = Router();

// ── Apple App Site Association (iOS Universal Links) ────────────────────────
router.get('/apple-app-site-association', (_req, res) => {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) {
    log.error('APPLE_TEAM_ID not set');
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
              '/': '/org/invite/*',
              comment: 'Org invite accept deep links (Phase 5)',
            },
            {
              '/': '/org/*',
              comment: 'Public org page deep links (Phase 5)',
            },
            {
              '/': '/globe/*',
              comment: 'Globe room deep links',
            },
            {
              '/': '/g/*',
              comment: 'Group invite deep links',
            },
            {
              '/': '/u/*',
              comment: 'Profile share deep links (Phase 13 ATTR-02)',
            },
            {
              '/': '/invite*',
              comment: 'Referral invite deep links',
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
  // Accept a comma-separated list so we can advertise BOTH the Play App Signing
  // key (what Play-distributed installs are re-signed with — the cert Android
  // actually verifies) and the upload key (EAS / internal-test builds). Listing
  // only one breaks domain verification for the other.
  const fingerprints = (process.env.ANDROID_SHA256_FINGERPRINT ?? '')
    .split(',')
    .map((fp) => fp.trim())
    .filter(Boolean);

  if (fingerprints.length === 0) {
    log.error('ANDROID_SHA256_FINGERPRINT not set');
    res.status(503).json({ error: 'Asset links not configured' });
    return;
  }

  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.tribelife.app',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  res.type('application/json').json(assetlinks);
});

export default router;
