/**
 * Firebase Cloud Messaging (FCM) sender — Phase C, LOCKED DECISION 3.
 *
 * Backend-only Node service (firebase-admin is NOT a mobile dependency). Sends
 * raw FCM messages to Android devices that own an FCM device token. iOS + Expo
 * tokens continue to use the Expo gateway (services/pushNotifications.ts).
 *
 * The whole send path is gated behind ANDROID_FCM_ENABLED at the call sites; a
 * missing FIREBASE_SERVICE_ACCOUNT is a safe no-op here (never throws) so an
 * unset secret can never crash the server.
 *
 * Modular subpath imports are MANDATORY: under Node 24 CJS interop the legacy
 * `admin.credential` namespace is undefined (spike-confirmed), so we import from
 * `firebase-admin/app` and `firebase-admin/messaging` directly.
 */
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import logger from '../lib/logger';

const log = logger.child({ module: 'fcm' });

export type FcmSendResult = 'ok' | 'unregistered' | 'error';

// Lazy singleton. `undefined` = not yet initialised; `null` = initialisation
// impossible (missing/invalid secret) — sends become no-ops without throwing.
let fcmApp: App | null | undefined;
let missingSecretLogged = false;

/**
 * Lazily initialise (once) the firebase-admin App from the
 * FIREBASE_SERVICE_ACCOUNT env var (full JSON string — NOT a file path; DO App
 * Platform env). Returns null when the secret is absent/invalid so callers can
 * no-op. Never throws.
 */
function getFcmApp(): App | null {
  if (fcmApp !== undefined) return fcmApp;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    if (!missingSecretLogged) {
      log.warn('FIREBASE_SERVICE_ACCOUNT unset — FCM sends are a no-op');
      missingSecretLogged = true;
    }
    fcmApp = null;
    return fcmApp;
  }

  try {
    const existing = getApps();
    if (existing.length > 0) {
      fcmApp = existing[0];
      return fcmApp;
    }
    const serviceAccount = JSON.parse(raw);
    fcmApp = initializeApp({ credential: cert(serviceAccount) });
    log.info('firebase-admin initialised for FCM');
    return fcmApp;
  } catch (err) {
    log.error({ err }, 'Failed to initialise firebase-admin — FCM sends disabled');
    fcmApp = null;
    return fcmApp;
  }
}

// firebase-admin surfaces UNREGISTERED as this error code; callers prune the row.
const UNREGISTERED_CODE = 'messaging/registration-token-not-registered';

function classifyError(err: unknown): FcmSendResult {
  const code = (err as { code?: string })?.code;
  if (code === UNREGISTERED_CODE) return 'unregistered';
  return 'error';
}

/**
 * Person push (DM / group / room / globe message): DATA-ONLY message (no
 * `notification` block) so the Android background handler renders MessagingStyle
 * with the sender avatar. All `data` values must already be strings.
 * Returns 'unregistered' on a dead token so the caller can prune it.
 */
export async function sendFcmDataMessage(
  token: string,
  data: Record<string, string>,
): Promise<FcmSendResult> {
  const app = getFcmApp();
  if (!app) return 'error';
  try {
    await getMessaging(app).send({
      token,
      data,
      android: { priority: 'high' },
    });
    return 'ok';
  } catch (err) {
    const result = classifyError(err);
    if (result === 'error') log.error({ err }, 'FCM data message send failed');
    return result;
  }
}

/**
 * Non-person push (beacon_match / news / moderation / system): an FCM
 * `notification` message (title/body) + optional data. Android auto-displays it
 * (no avatar/JS handler needed). Used because the service-wins plugin removes
 * the Expo FirebaseMessagingService on the new Android build, so the Expo
 * gateway can no longer reach these devices (LOCKED DECISION 4). All `data`
 * values must already be strings.
 * Returns 'unregistered' on a dead token so the caller can prune it.
 */
export async function sendFcmNotificationMessage(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<FcmSendResult> {
  const app = getFcmApp();
  if (!app) return 'error';
  try {
    await getMessaging(app).send({
      token,
      notification: { title, body },
      ...(data ? { data } : {}),
      android: { priority: 'high' },
    });
    return 'ok';
  } catch (err) {
    const result = classifyError(err);
    if (result === 'error') log.error({ err }, 'FCM notification message send failed');
    return result;
  }
}
