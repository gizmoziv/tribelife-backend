// AES-256-GCM unsubscribe-token decrypt side of the FROZEN cross-repo contract
// Marketing-Hub/.planning/phases/11-email-marketing/TRIBELIFE-CONTRACT.md (section 3).
// This module is intentionally PURE: its only import is `node:crypto`. No `../db`,
// no `../lib/logger`, no `express` — so it stays independently runnable/testable
// with zero side effects, and so a missing/malformed secret can never crash boot
// (the caller reads process.env per-request and passes the result in as a param;
// see the `src/middleware/auth.ts` module-scope-throw ANTI-pattern this file must
// NOT copy). Every function here returns `null` on any failure — never throws,
// never logs, never distinguishes *why* something was rejected (contract section
// 3 rule 6): this is what prevents a user-enumeration oracle at the route layer.
import { createDecipheriv } from 'node:crypto';

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_USER_ID = 2147483647;
const SECRET_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

// Loads the shared secret into a 32-byte key. Per contract section 2, key
// derivation is NONE (no HKDF/scrypt/PBKDF2/hashing) — the secret is already
// 256 random bits from `openssl rand -hex 32`. Takes the hex as a parameter
// (rather than reading process.env itself) so the caller can read the env var
// fresh on every request.
export function loadUnsubscribeKey(hex: string | undefined): Buffer | null {
  if (typeof hex !== 'string' || !SECRET_HEX_PATTERN.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

// Verbatim reference implementation, TRIBELIFE-CONTRACT.md section 3. Do not
// "improve" it, reorder its guards, or convert its regexes.
export function decryptToken(token: unknown, key: Buffer): number | null {
  try {
    if (typeof token !== 'string') return null;
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 1 + IV_LEN + 1 + TAG_LEN) return null;
    if (raw[0] !== VERSION) return null;
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(1, 1 + IV_LEN), { authTagLength: TAG_LEN });
    d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    const pt = Buffer.concat([d.update(raw.subarray(1 + IV_LEN, raw.length - TAG_LEN)), d.final()]).toString('utf8');
    if (!/^[1-9]\d{0,9}$/.test(pt)) return null;
    const n = Number(pt);
    return n <= MAX_USER_ID ? n : null;
  } catch {
    return null;
  }
}
