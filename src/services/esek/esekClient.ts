/**
 * esekClient — SSRF-guarded fetch + parse of the Esek (esek.biz) Shopify catalog.
 *
 * Esek exposes its catalog as a standard public Shopify `products.json` feed
 * (paginated, 250/page). We page through it via a JSON GET routed through the
 * SSRF guard's load-bearing primitives (guardedLookup closes DNS-rebinding at
 * connect time; isBlockedIp rejects literal-IP hosts up front — mirroring
 * safeFetchHtml's assertHttpUrl, which is HTML-only and cannot serve JSON).
 *
 * Mirrors src/services/jobs/atsAdapter.ts: typed source interfaces, a browser UA
 * constant, per-source fetch fn, an exported orchestrator. The DB write lives in
 * esekStore — this module is fetch + pure-mapping only.
 *
 * ⚠ fetchAllProducts makes outbound HTTP. It must only run behind the gated cron
 * (ESEK_SYNC_ENABLED) or a human-invoked trigger — never ad-hoc.
 */
import https from 'https';
import net from 'net';
import logger from '../../lib/logger';
import { guardedLookup, isBlockedIp } from '../../utils/ssrfGuard';

const log = logger.child({ module: 'esek-sync' });

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ESEK_BASE = 'https://esek.biz/products.json';
const PAGE_LIMIT = 250; // Shopify caps products.json at 250/page
const MAX_PAGES = 40; // hard ceiling → 10k products; guards against unbounded loops (D-03)
const MAX_429_RETRIES = 3; // per-page retry budget on rate-limit
const MAX_BACKOFF_MS = 60_000; // cap Retry-After backoff at 60s
const REQUEST_TIMEOUT_MS = 15_000; // per-page total timeout
const MAX_BYTES = 8 * 1_024 * 1_024; // 8 MB response cap (250 products of JSON)

// ── Source shapes (Shopify products.json) ─────────────────────────────────────

interface ShopifyVariant {
  price: string;
  compare_at_price: string | null;
  available: boolean;
  sku?: string | null;
}

interface ShopifyImage {
  src: string;
  width?: number | null;
  height?: number | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[] | null;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

/**
 * The esek_products insert shape — the contract with esekStore.upsertProducts.
 * Column names match the esekProducts pgTable (Task 1) exactly.
 */
export interface EsekRow {
  shopifyId: number;
  title: string;
  handle: string;
  price: string; // numeric column accepts string; Shopify prices arrive as "60.00"
  compareAtPrice: string | null;
  imageUrl: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[] | null;
  available: boolean;
  publishedAt: Date | null;
}

// ── Pure mapper ───────────────────────────────────────────────────────────────

/**
 * Normalize one Shopify product into an EsekRow. Pure, no I/O — unit-testable.
 * - price/compareAtPrice from variants[0] (strings kept for the numeric column)
 * - imageUrl from images[0].src
 * - available = ANY variant available:true
 * - empty variants → price '0', available false (never throws)
 * - empty images → imageUrl null
 */
export function mapProduct(p: ShopifyProduct): EsekRow {
  const firstVariant = p.variants?.[0];
  const firstImage = p.images?.[0];
  const published = p.published_at ? new Date(p.published_at) : null;
  return {
    shopifyId: p.id,
    title: p.title,
    handle: p.handle,
    price: firstVariant?.price ?? '0',
    compareAtPrice: firstVariant?.compare_at_price ?? null,
    imageUrl: firstImage?.src ?? null,
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags: p.tags ?? null,
    available: (p.variants ?? []).some((v) => v.available === true),
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
  };
}

// ── SSRF-guarded JSON GET ─────────────────────────────────────────────────────

interface PageResult {
  status: number;
  retryAfter: number | null; // seconds, when the server sent Retry-After on a 429
  products: ShopifyProduct[] | null; // present only on a parsed 2xx JSON body
}

/**
 * GET a products.json page SSRF-safely. Routes through guardedLookup (connect-time
 * IP validation — closes DNS-rebinding) with an up-front literal-IP host check
 * mirroring safeFetchHtml's assertHttpUrl. Caps body size + total time. Resolves
 * with the parsed products (2xx) or a status/retryAfter for the caller to handle
 * (e.g. 429). Rejects only on transport/timeout/cap/parse errors.
 */
function fetchPage(page: number): Promise<PageResult> {
  return new Promise<PageResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(`${ESEK_BASE}?limit=${PAGE_LIMIT}&page=${page}`);
    } catch {
      return reject(new Error('Invalid Esek URL'));
    }
    // Block IP-literal hosts up front — Node does NOT call our guarded lookup for
    // a literal IP, so the lookup-based defense is bypassed for them.
    const host = target.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (net.isIP(host) && isBlockedIp(host)) {
      return reject(new Error(`Blocked IP host: ${host}`));
    }

    const req = https.request(
      target,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Rate-limited: surface status + Retry-After for the caller to back off.
        if (status === 429) {
          res.resume(); // discard body
          const header = res.headers['retry-after'];
          const retryAfter = header ? Number(Array.isArray(header) ? header[0] : header) : null;
          resolve({
            status,
            retryAfter: retryAfter !== null && !Number.isNaN(retryAfter) ? retryAfter : null,
            products: null,
          });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, retryAfter: null, products: null });
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
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              products?: ShopifyProduct[];
            };
            resolve({ status, retryAfter: null, products: parsed.products ?? [] });
          } catch (err) {
            reject(err instanceof Error ? err : new Error('JSON parse failed'));
          }
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
    }, REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));

    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Page through the full Esek catalog. Loops products.json?limit=250&page=N from
 * N=1, stopping when a page returns an empty products array OR MAX_PAGES is hit.
 * On 429: waits Retry-After (bounded ≤60s), retries the SAME page up to
 * MAX_429_RETRIES; if still 429 after the budget, warns and breaks the loop
 * (never crashes the cron). Per-page parse failures are isolated so one bad page
 * does not abort the whole run. Returns the mapped EsekRow[].
 */
export async function fetchAllProducts(): Promise<EsekRow[]> {
  const runStart = Date.now();
  const rows: EsekRow[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    // Fetch the page, backing off + retrying the SAME page on 429 up to the budget.
    let result: PageResult | null = null;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      try {
        result = await fetchPage(page);
      } catch (err) {
        // Isolate per-page transport/parse failure: skip this page, keep going.
        log.warn({ err, page }, 'Esek page fetch failed — skipping page');
        result = null;
        break;
      }
      if (result.status !== 429) break; // got a real (non-rate-limited) response
      if (attempt >= MAX_429_RETRIES) {
        log.warn({ page, attempts: attempt }, 'Esek 429 retry budget exhausted — stopping run');
        return rows;
      }
      const waitMs = Math.min((result.retryAfter ?? 2 ** attempt) * 1000, MAX_BACKOFF_MS);
      log.warn({ page, attempt, waitMs }, 'Esek rate-limited (429) — backing off');
      await sleep(waitMs);
      result = null; // force another attempt at the same page
    }

    if (!result) continue; // page fetch failed / still 429 after budget → skip it

    if (result.products === null) {
      // Non-2xx, non-429 → treat as a bad page, skip it.
      log.warn({ page, status: result.status }, 'Esek page returned non-2xx — skipping page');
      continue;
    }

    if (result.products.length === 0) {
      // Empty page = end of catalog.
      log.info(
        { pages: page - 1, total: rows.length, duration_ms: Date.now() - runStart },
        'Esek fetch complete',
      );
      return rows;
    }

    for (const product of result.products) {
      try {
        rows.push(mapProduct(product));
      } catch (err) {
        log.warn({ err, shopifyId: product?.id, page }, 'Esek product map failed — skipping');
      }
    }
    log.info({ page, count: result.products.length, running: rows.length }, 'Esek page fetched');
  }

  log.info(
    { pages: MAX_PAGES, total: rows.length, duration_ms: Date.now() - runStart },
    'Esek fetch hit MAX_PAGES cap',
  );
  return rows;
}
