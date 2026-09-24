// End-to-end proof for Task 1 of Phase 37 Plan 01: a real HTTP POST reaches the
// mounted /api/unsubscribe router and every structurally-different outcome
// (valid-shaped token / malformed token / missing token / missing secret) plus
// a GET all produce a byte-identical 200 response with no redirect.
//
// ⛔ DATABASE SAFETY — this script must NEVER cause a database query. Two
// independent guards, both required:
//   (a) every case below is constructed so decryptToken cannot return a user
//       id (all-`f` wrong key, or the secret env var deleted entirely), so the
//       db.update branch inside routes/unsubscribe.ts is unreachable. This
//       script NEVER sets UNSUBSCRIBE_TOKEN_SECRET to the contract's published
//       test key — that key belongs only in scripts/verify-unsubscribe-token.ts,
//       which imports no database module at all.
//   (b) the verify command (see 37-01-PLAN.md) invokes this script with
//       DATABASE_URL overridden to an unreachable local address, so a
//       hypothetical regression that did reach the update fails loudly
//       against a dead socket instead of touching production.
import express from 'express';

// Set BEFORE the route module (and its transitive `src/lib/logger.ts` import,
// which reads LOG_LEVEL at module-load time) is loaded. Static ES imports are
// hoisted ahead of ordinary statements, so the route module is loaded via a
// dynamic import() below — the one construct that runs in program order —
// to guarantee this assignment takes effect first. Without this, the route's
// contract-required coarse-outcome log line (pino-pretty's async transport)
// can flush to stdout AFTER this script's own UNSUBSCRIBE_ROUTE_OK marker,
// breaking the "final line and nothing after it" contract of this script.
process.env.LOG_LEVEL = 'silent';

// A syntactically valid 64-hex-char key that is NOT the key any real token was
// minted under (contract's published test key lives only in
// verify-unsubscribe-token.ts).
const WRONG_KEY_HEX = 'f'.repeat(64);
// The contract's real v1 test-vector token (TRIBELIFE-CONTRACT.md section 4).
// Decrypting it under WRONG_KEY_HEX must fail (wrong key), so this can never
// reach the database update branch.
const V1_TOKEN = 'AaChoqOkpaanqKmqq9cqTxlwz6vKqmyliiufksVibWeGIQ';

interface CaseResult {
  status: number;
  body: string;
  location: string | null;
}

async function postCase(url: string): Promise<CaseResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

async function getCase(url: string): Promise<CaseResult> {
  const res = await fetch(url, { method: 'GET' });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

async function main(): Promise<void> {
  const { default: unsubscribeRouter } = await import('../src/routes/unsubscribe');
  const app = express();
  app.use('/api/unsubscribe', unsubscribeRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    console.log('MISMATCH could not determine listening port');
    process.exit(1);
    return;
  }
  const base = `http://127.0.0.1:${addr.port}/api/unsubscribe`;

  const results: CaseResult[] = [];

  try {
    // Case 1: v1 test-vector token, wrong (all-f) key.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = WRONG_KEY_HEX;
    results.push(await postCase(`${base}?t=${encodeURIComponent(V1_TOKEN)}`));

    // Case 2: malformed token, same wrong key.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = WRONG_KEY_HEX;
    results.push(await postCase(`${base}?t=${encodeURIComponent('not a token!!')}`));

    // Case 3: no `t` query parameter at all, same wrong key.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = WRONG_KEY_HEX;
    results.push(await postCase(base));

    // Case 4: v1 token, with the secret variable absent from the environment.
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    results.push(await postCase(`${base}?t=${encodeURIComponent(V1_TOKEN)}`));

    // Case 5: GET with the v1 token, wrong key.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = WRONG_KEY_HEX;
    results.push(await getCase(`${base}?t=${encodeURIComponent(V1_TOKEN)}`));
  } finally {
    server.close();
  }

  const statuses = results.map((r) => r.status);
  const bodies = results.map((r) => r.body);
  const locations = results.map((r) => r.location);

  let ok = true;

  if (!statuses.every((s) => s === 200)) {
    console.log(`MISMATCH non-200 status among: ${JSON.stringify(statuses)}`);
    ok = false;
  }
  if (!bodies.every((b) => b === bodies[0])) {
    console.log(`MISMATCH response bodies differ: ${JSON.stringify(bodies)}`);
    ok = false;
  }
  if (!locations.every((l) => l === null)) {
    console.log(`MISMATCH a response carries a location header: ${JSON.stringify(locations)}`);
    ok = false;
  }

  if (!ok) {
    process.exit(1);
    return;
  }

  console.log('UNSUBSCRIBE_ROUTE_OK 5/5');
}

main().catch((err) => {
  console.log(`MISMATCH uncaught error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
