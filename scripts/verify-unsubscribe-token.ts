// Pins decryptToken/loadUnsubscribeKey against the published test vectors in
// Marketing-Hub/.planning/phases/11-email-marketing/TRIBELIFE-CONTRACT.md
// section 4. If this script passes, TribeLife's decoder agrees byte-for-byte
// with Marketing-Hub's mint-side oracle (contract's own stated condition).
//
// This script imports ONLY the module under test and node:crypto — no
// database module, no Express module, no logger — so it is safe to run with
// the published test-only key below.
import { decryptToken, loadUnsubscribeKey } from '../src/lib/unsubscribeToken';
import { createCipheriv, randomBytes } from 'node:crypto';

// TEST-ONLY KEY. This key is published in TRIBELIFE-CONTRACT.md and in
// Marketing-Hub's own test suite so both repos can assert identical numbers.
// It is NOT, and must never become, a deployed UNSUBSCRIBE_TOKEN_SECRET.
const TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex');

// Transcribed character-for-character from TRIBELIFE-CONTRACT.md section 4.
const V1_TOKEN = 'AaChoqOkpaanqKmqq9cqTxlwz6vKqmyliiufksVibWeGIQ';
const LEGACY_TOKEN = 'oKGio6Slpqeoqaqr1ypPGXDPq8qqbKWKK5-SxWJtZ4Yh';

const TOTAL_CASES = 21;
let passCount = 0;
const failedIds: string[] = [];

function check(id: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passCount++;
    return;
  }
  failedIds.push(id);
  console.log(`FAIL ${id} actual=${JSON.stringify(actual)}`);
}

function mutateToken(token: string, mutate: (raw: Buffer) => void): string {
  const raw = Buffer.from(token, 'base64url');
  mutate(raw);
  return raw.toString('base64url');
}

function mintToken(userId: number, iv: Buffer, key: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const plaintext = Buffer.from(String(userId), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), iv, ciphertext, tag]).toString('base64url');
}

// ── Positives ────────────────────────────────────────────────────────────
// P1: the published v1 test-vector token decrypts to 12345 under the test key.
{
  const actual = decryptToken(V1_TOKEN, TEST_KEY);
  check('P1', actual === 12345, actual);
}

// P2: a freshly minted token for id 836 with a random IV round-trips to 836.
{
  const iv = randomBytes(12);
  const p2Token = mintToken(836, iv, TEST_KEY);
  const actual = decryptToken(p2Token, TEST_KEY);
  check('P2', actual === 836, actual);
}

// ── Negatives (each must return null) ───────────────────────────────────
// N1: flipped ciphertext bit — byte index 13 is the first ciphertext byte
// (index 0 = version, 1-12 = IV, 13.. = ciphertext).
{
  const n1 = mutateToken(V1_TOKEN, (raw) => { raw[13] ^= 0x01; });
  const actual = decryptToken(n1, TEST_KEY);
  check('N1', actual === null, actual);
}

// N2: flipped tag bit (last byte).
{
  const n2 = mutateToken(V1_TOKEN, (raw) => { raw[raw.length - 1] ^= 0x80; });
  const actual = decryptToken(n2, TEST_KEY);
  check('N2', actual === null, actual);
}

// N3: truncated token (last 4 characters dropped).
{
  const n3 = V1_TOKEN.slice(0, -4);
  const actual = decryptToken(n3, TEST_KEY);
  check('N3', actual === null, actual);
}

// N4: wrong key (ff repeated 32 times).
{
  const wrongKey = Buffer.from('ff'.repeat(32), 'hex');
  const actual = decryptToken(V1_TOKEN, wrongKey);
  check('N4', actual === null, actual);
}

// N5a/b/c: altered version byte (0x00, 0x02, 0xff).
{
  const n5a = mutateToken(V1_TOKEN, (raw) => { raw[0] = 0x00; });
  check('N5a', decryptToken(n5a, TEST_KEY) === null, decryptToken(n5a, TEST_KEY));
  const n5b = mutateToken(V1_TOKEN, (raw) => { raw[0] = 0x02; });
  check('N5b', decryptToken(n5b, TEST_KEY) === null, decryptToken(n5b, TEST_KEY));
  const n5c = mutateToken(V1_TOKEN, (raw) => { raw[0] = 0xff; });
  check('N5c', decryptToken(n5c, TEST_KEY) === null, decryptToken(n5c, TEST_KEY));
}

// N6: legacy unversioned layout — same key/IV/id, no version byte. Must
// decode to invalid, not fall back to the old format.
{
  const actual = decryptToken(LEGACY_TOKEN, TEST_KEY);
  check('N6', actual === null, actual);
}

// N7a-g: short garbage and wrong types.
check('N7a', decryptToken('abc', TEST_KEY) === null);
check('N7b', decryptToken('', TEST_KEY) === null);
check('N7c', decryptToken('not a token!!', TEST_KEY) === null);
check('N7d', decryptToken(undefined, TEST_KEY) === null);
check('N7e', decryptToken(null, TEST_KEY) === null);
check('N7f', decryptToken(42, TEST_KEY) === null);
check('N7g', decryptToken({}, TEST_KEY) === null);

// ── Key loader cases ─────────────────────────────────────────────────────
// K1: a valid 64-char hex key loads to a 32-byte Buffer.
{
  const k1 = loadUnsubscribeKey(TEST_KEY_HEX);
  check('K1', k1 !== null && Buffer.isBuffer(k1) && k1.length === 32, k1);
}
// K2: the test key hex with one character removed (63 chars) returns null.
check('K2', loadUnsubscribeKey(TEST_KEY_HEX.slice(0, -1)) === null);
// K3: a 64-character string containing a non-hex character returns null.
check('K3', loadUnsubscribeKey(`${TEST_KEY_HEX.slice(0, -1)}g`) === null);
// K4: an undefined secret returns null.
check('K4', loadUnsubscribeKey(undefined) === null);

if (failedIds.length > 0) {
  console.log(`FAIL ${failedIds.length}/${TOTAL_CASES} cases failed: ${failedIds.join(', ')}`);
  process.exit(1);
}

console.log(`TOKEN_VECTORS_OK ${passCount}/${TOTAL_CASES}`);
