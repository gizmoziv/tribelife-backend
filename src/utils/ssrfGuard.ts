/**
 * ssrfGuard — SSRF-safe HTML fetcher for the link-preview unfurl feature.
 *
 * THIS IS SECURITY-CRITICAL. The whole point of this module is to fetch an
 * arbitrary user-supplied URL WITHOUT letting an attacker reach internal/cloud
 * metadata endpoints (169.254.169.254), localhost, RFC1918 ranges, etc.
 *
 * Two defenses, layered:
 *  1. A custom DNS `lookup` (Node `net.LookupFunction`) wired into the core
 *     http/https request options. The CONNECT-time resolved IP is validated
 *     against the block-list, so a hostname that resolves to a private IP — or
 *     a DNS-rebinding attacker that flips the record between our check and the
 *     socket connect (TOCTOU) — is rejected at the moment the socket is about
 *     to connect, not earlier. This is the load-bearing control.
 *  2. Per-hop scheme + host re-validation on every redirect Location before we
 *     follow it (max 3 hops). A 302 to http://169.254.169.254/ is caught here
 *     too, but even if it weren't, the guarded lookup at connect time would
 *     still block it.
 *
 * Plus: 5s total timeout, 1 MB response cap, text/html-only parsing, https/http
 * schemes only, GET only, realistic User-Agent.
 */
import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';

const TOTAL_TIMEOUT_MS = 5_000;
const MAX_BYTES = 1_024 * 1_024; // 1 MB
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (compatible; TribeLifeBot/1.0; +https://tribelife.app)';

// ── IP block-list ─────────────────────────────────────────────────────────

/** Parse a dotted-quad IPv4 string to its 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** True if `ip` (v4 int) falls inside `base/prefixLen`. */
function inV4Cidr(ipInt: number, baseIp: string, prefixLen: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  if (prefixLen === 0) return true;
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return true; // unparseable → block (fail closed)
  return (
    inV4Cidr(ipInt, '0.0.0.0', 8) || // "this" network / unspecified
    inV4Cidr(ipInt, '10.0.0.0', 8) || // private
    inV4Cidr(ipInt, '127.0.0.0', 8) || // loopback
    inV4Cidr(ipInt, '169.254.0.0', 16) || // link-local (incl. cloud metadata)
    inV4Cidr(ipInt, '172.16.0.0', 12) || // private
    inV4Cidr(ipInt, '192.168.0.0', 16) || // private
    inV4Cidr(ipInt, '100.64.0.0', 10) // CGNAT (RFC 6598)
  );
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unspecified / loopback.
  if (lower === '::' || lower === '::1') return true;

  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 against the v4 list.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // Some stacks present mapped addresses in hex form (::ffff:7f00:1). Treat the
  // whole ::ffff:/96 prefix as suspect and block it conservatively.
  if (lower.startsWith('::ffff:')) return true;

  // Strip a zone id if present (fe80::1%eth0).
  const addr = lower.split('%')[0];

  // fc00::/7 — Unique Local Addresses (first byte 0xfc or 0xfd).
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true;

  // fe80::/10 — link-local (fe80..febf).
  if (/^fe[89ab][0-9a-f]?:/.test(addr)) return true;

  return false;
}

/**
 * True if `ip` (any family) is a non-routable / private / reserved address we
 * refuse to connect to. Fails CLOSED: an unparseable address is blocked.
 */
export function isBlockedIp(ip: string): boolean {
  if (!ip) return true;
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal → block
}

// ── Guarded DNS lookup ──────────────────────────────────────────────────────

/**
 * A `net.LookupFunction` that resolves the host and rejects if ANY returned
 * address is blocked. Passed into http/https request options so the IP that the
 * socket is about to connect to is the one we validate (closes the
 * DNS-rebinding / TOCTOU gap). We force `all: true` internally so a host that
 * resolves to a mix of public + private addresses is still rejected.
 */
export const guardedLookup: net.LookupFunction = ((
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => {
  // Normalize: support both lookup(host, cb) and lookup(host, opts, cb).
  let cb = callback;
  let family = 0;
  if (typeof options === 'function') {
    cb = options as typeof callback;
  } else if (typeof options === 'number') {
    family = options;
  } else if (options && typeof options === 'object') {
    // options.family may be a number or the strings 'IPv4'/'IPv6'.
    const f = options.family;
    if (typeof f === 'number') family = f;
    else if (f === 'IPv4') family = 4;
    else if (f === 'IPv6') family = 6;
  }

  dns.lookup(hostname, { all: true, family }, (err, addresses) => {
    if (err) return cb(err, '', undefined);
    const list = addresses as dns.LookupAddress[];
    if (!list || list.length === 0) {
      return cb(
        Object.assign(new Error('No addresses resolved'), {
          code: 'ENOTFOUND',
        }),
        '',
        undefined,
      );
    }
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        return cb(
          Object.assign(
            new Error(`Blocked address ${a.address} for host ${hostname}`),
            { code: 'EBLOCKED' },
          ),
          '',
          undefined,
        );
      }
    }
    // Hand back the first (validated) address.
    const first = list[0];
    cb(null, first.address, first.family);
  });
}) as net.LookupFunction;

// ── Safe single-hop fetch ───────────────────────────────────────────────────

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  location: string | null;
  body: string | null; // present only for terminal text/html 2xx responses
}

/** Validate that a URL is a syntactically-ok http/https URL. Throws otherwise. */
function assertHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked scheme: ${u.protocol}`);
  }
  if (!u.hostname) throw new Error('Missing host');
  return u;
}

/**
 * Perform ONE request (no redirect following). On a redirect status we return
 * the Location for the caller to validate + follow. On a terminal 2xx we read
 * the body (capped + html-gated). Rejects on transport/timeout/cap/scheme
 * errors. The guarded lookup makes the connect-time IP safe.
 */
function fetchOnce(target: URL, deadline: number): Promise<FetchResult> {
  return new Promise<FetchResult>((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return reject(new Error('Timeout'));

    const req = mod.request(
      target,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
        timeout: remainingMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location ?? null;

        // Redirect: drain + return the Location (don't read the body).
        if (status >= 300 && status < 400 && location) {
          res.resume(); // discard body
          resolve({ status, headers: res.headers, location, body: null });
          return;
        }

        // Only parse 2xx text/html.
        const contentType = String(res.headers['content-type'] ?? '');
        if (status < 200 || status >= 300 || !contentType.includes('text/html')) {
          res.resume();
          resolve({ status, headers: res.headers, location: null, body: null });
          return;
        }

        let received = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            location: null,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Timeout'));
    });
    // Hard ceiling independent of socket-idle timeout.
    const timer = setTimeout(() => {
      req.destroy(new Error('Timeout'));
    }, Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));

    req.end();
  });
}

/**
 * Fetch HTML from `url` SSRF-safely. Follows up to MAX_REDIRECTS redirects,
 * re-validating the scheme + host (and, via guardedLookup, the connect-time IP)
 * of every hop. Returns the HTML string and the final URL, or null when the
 * response is not usable HTML. Throws on any guard violation / transport error /
 * timeout — callers in linkPreview.ts swallow that into a `null` preview.
 */
export async function safeFetchHtml(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let current = assertHttpUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(current, deadline);

    if (result.location) {
      if (hop === MAX_REDIRECTS) {
        throw new Error('Too many redirects');
      }
      // Resolve relative redirects against the current URL, then re-validate
      // scheme + host before the next hop. guardedLookup re-checks the IP.
      const next = new URL(result.location, current);
      current = assertHttpUrl(next.toString());
      continue;
    }

    if (result.body === null) return null; // non-html / non-2xx / too large
    return { html: result.body, finalUrl: current.toString() };
  }

  throw new Error('Too many redirects');
}
