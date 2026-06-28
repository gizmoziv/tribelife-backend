import logger from '../../lib/logger';
import type { JobRow } from './jobStore';
import { upsertJobs } from './jobStore';

const log = logger.child({ module: 'ats-adapter' });

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * ATS (Applicant Tracking System) job-feed adapter — the LEGAL alternative to
 * scraping Indeed / JewishJobs. Greenhouse and Lever both expose PUBLIC, documented,
 * unauthenticated JSON board endpoints that are *intended* for syndication, so
 * consuming them is sanctioned (no ToS violation, unlike Indeed/JewishJobs scraping).
 *
 * Strategy: rather than aggregate a giant board, we pull directly from the ATS feeds
 * of individual Jewish organizations (Hillel, Federations, JCCs, day schools, Jewish
 * nonprofits). Every result is therefore a real Jewish-org job — no keyword false
 * positives — and 100% within terms.
 *
 * To add an org: find its ATS token on its careers page. Greenhouse boards look like
 * `boards.greenhouse.io/<token>`; Lever boards look like `jobs.lever.co/<token>`.
 * Confirm with:  curl https://boards-api.greenhouse.io/v1/boards/<token>/jobs
 *                curl https://api.lever.co/v0/postings/<token>?mode=json
 */
export type Ats = 'greenhouse' | 'lever' | 'breezy' | 'comeet';

export interface AtsSource {
  /** ATS board token (the slug in the board URL; for Comeet, the public board token). */
  token: string;
  ats: Ats;
  /** Human-readable org name; used as company fallback when the feed omits one. */
  label: string;
  /** Comeet ONLY: the company uid (`XX.XXX`) paired with `token` in the careers-api URL. */
  uid?: string;
}

/**
 * Confirmed-live Jewish-org ATS sources. Seeded with Hillel International
 * (greenhouse/hillel — ~81 global campus jobs, verified). Expand this list as
 * org tokens are discovered; the adapter handles any number of sources.
 */
export const ATS_SOURCES: AtsSource[] = [
  { token: 'hillel', ats: 'greenhouse', label: 'Hillel International' }, // ~81 jobs
  { token: 'thejewishfederationsofnorthamerica', ats: 'greenhouse', label: 'Jewish Federations of North America' }, // ~5
  { token: 'bbyo', ats: 'greenhouse', label: 'BBYO' }, // ~24
  { token: 'bbyointernal19', ats: 'greenhouse', label: 'BBYO Passport (Israel staff)' }, // ~3
  { token: 'sanfranciscocampusforjewishliving', ats: 'greenhouse', label: 'San Francisco Campus for Jewish Living' }, // ~17
  { token: 'hebrewpublic', ats: 'greenhouse', label: 'Hebrew Public (charter schools)' }, // ~30 — Hebrew-language charter network
  // ── Breezy HR ──
  { token: 'repair-the-world', ats: 'breezy', label: 'Repair the World' }, // ~3
  { token: 'keshet-inc', ats: 'breezy', label: 'Keshet' }, // ~2
  { token: 'sefaria', ats: 'breezy', label: 'Sefaria' }, // 0 now — board live, will light up when they post
  { token: 'foundation-for-jewish-camp', ats: 'breezy', label: 'Foundation for Jewish Camp' }, // 0 now — board live
  // ── Comeet (Israel-focused; needs uid + token pair) ──
  { token: '97F427997F097F38FA55772F7B2F7B4BF8', uid: '79.00F', ats: 'comeet', label: 'OpenDor Media (Unpacked / ISRAEL21c)' }, // ~4
  { token: 'A2B472D1E815B833D025B83472D1456A2B0', uid: '2A.00B', ats: 'comeet', label: 'CET — Center for Educational Technology' }, // ~18 — Israeli ed-tech NGO, mostly Hebrew-only Tel Aviv
];

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags + decode the entities ATS feeds emit, then cap length.
 * Greenhouse's content=true field is DOUBLE entity-encoded HTML (`&amp;lt;h1&amp;gt;`,
 * `&amp;nbsp;`). So we peel one `&amp;` layer FIRST, then decode structural entities,
 * THEN strip tags — otherwise tags/&nbsp; resurface as literal text after stripping.
 */
function htmlToText(html: string | null | undefined, max = 600): string | null {
  if (!html) return null;
  const text = html
    .replace(/&amp;/g, '&') // peel one encoding layer (handles double-encoding)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ') // strip real + decoded tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * ISO timestamp or epoch-ms → 'MM/DD/YYYY'. This format is REQUIRED: the jobs feed
 * (routes/jobs.ts) age-filters with `TO_DATE(posted_date, 'MM/DD/YYYY')`, matching what
 * the JewishJobs scraper emits. Emitting ISO YYYY-MM-DD here would misparse and silently
 * drop every ATS job from the 60-day feed window. UTC to keep day boundaries stable.
 */
function toDateString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

// ── Greenhouse ───────────────────────────────────────────────────────────────

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  company_name?: string | null;
  location?: { name?: string | null } | null;
  content?: string | null; // HTML, only present with ?content=true
  first_published?: string | null;
  updated_at?: string | null;
}

async function fetchGreenhouse(src: AtsSource): Promise<JobRow[]> {
  // content=true folds the full description into the list call → 1 request, no N+1.
  const url = `https://boards-api.greenhouse.io/v1/boards/${src.token}/jobs?content=true`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`greenhouse ${src.token}: HTTP ${res.status}`);
  const data = (await res.json()) as { jobs?: GreenhouseJob[] };
  const jobs = data.jobs ?? [];

  return jobs.map((j) => ({
    source: 'greenhouse',
    externalRef: `${src.token}:${j.id}`, // token-scoped so ids never collide across orgs
    title: j.title,
    company: (j.company_name || src.label).trim() || src.label,
    location: j.location?.name?.trim() || null,
    postedDate: toDateString(j.first_published ?? j.updated_at),
    description: htmlToText(j.content),
    logoUrl: null, // Greenhouse job payload carries no logo
    viewCount: 0,
    jobUrl: j.absolute_url,
  }));
}

// ── Lever ────────────────────────────────────────────────────────────────────

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  descriptionPlain?: string | null;
  createdAt?: number | null;
  categories?: { location?: string | null; team?: string | null } | null;
}

async function fetchLever(src: AtsSource): Promise<JobRow[]> {
  const url = `https://api.lever.co/v0/postings/${src.token}?mode=json`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`lever ${src.token}: HTTP ${res.status}`);
  const postings = (await res.json()) as LeverPosting[];

  return postings.map((p) => ({
    source: 'lever',
    externalRef: `${src.token}:${p.id}`,
    title: p.text,
    company: src.label, // Lever postings carry no company name → use registry label
    location: p.categories?.location?.trim() || null,
    postedDate: toDateString(p.createdAt),
    description: htmlToText(p.descriptionPlain),
    logoUrl: null,
    viewCount: 0,
    jobUrl: p.hostedUrl,
  }));
}

// ── Breezy HR ────────────────────────────────────────────────────────────────

interface BreezyPosition {
  id: string;
  name: string; // Breezy uses `name` for the title — there is no `title` field
  url: string;
  published_date?: string | null;
  location?: {
    city?: string | null;
    state?: { name?: string | null } | null;
    country?: { name?: string | null } | null;
    is_remote?: boolean | null;
  } | null;
}

function breezyLocation(loc: BreezyPosition['location']): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.state?.name, loc.country?.name]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  if (parts.length) return parts.join(', ');
  return loc.is_remote ? 'Remote' : null;
}

async function fetchBreezy(src: AtsSource): Promise<JobRow[]> {
  const url = `https://${src.token}.breezy.hr/json`;
  // Breezy 302-redirects when the board token doesn't exist; only a 200 is a real board.
  // redirect:'manual' stops us following a dead token into a non-JSON HTML page.
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual' });
  if (res.status !== 200) throw new Error(`breezy ${src.token}: HTTP ${res.status}`);
  const positions = (await res.json()) as BreezyPosition[];

  return positions.map((p) => ({
    source: 'breezy',
    externalRef: `${src.token}:${p.id}`,
    title: p.name,
    company: src.label, // list `company` is the Breezy account name → prefer registry label
    location: breezyLocation(p.location),
    postedDate: toDateString(p.published_date),
    description: null, // not in the /json list endpoint; lives on the per-position page
    logoUrl: null,
    viewCount: 0,
    jobUrl: p.url,
  }));
}

// ── Comeet ───────────────────────────────────────────────────────────────────
// Different shape from the others: the careers-api is keyed by a company uid + a
// public board token (both extracted from the org's comeet.com/jobs page), the
// response is a flat array, and the title field is `name`. Descriptions are not in
// the list payload (would be an N+1 detail call) → left null.

interface ComeetPosition {
  uid: string;
  name: string; // title
  company_name?: string | null;
  time_updated?: string | null;
  location?: { name?: string | null; city?: string | null; country?: string | null } | null;
  url_comeet_hosted_page?: string | null;
  url_active_page?: string | null;
}

async function fetchComeet(src: AtsSource): Promise<JobRow[]> {
  if (!src.uid) throw new Error(`comeet ${src.label}: missing uid (required with token)`);
  const url = `https://www.comeet.co/careers-api/2.0/company/${src.uid}/positions?token=${src.token}`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`comeet ${src.uid}: HTTP ${res.status}`);
  const positions = (await res.json()) as ComeetPosition[];

  return positions.map((p) => ({
    source: 'comeet',
    externalRef: `${src.uid}:${p.uid}`, // company-uid-scoped position uid
    title: p.name,
    company: (p.company_name || src.label).trim() || src.label,
    location: p.location?.name?.trim() || p.location?.city?.trim() || null,
    postedDate: toDateString(p.time_updated),
    description: null, // not in list payload; detail endpoint would be an N+1
    logoUrl: null,
    viewCount: 0,
    jobUrl: p.url_comeet_hosted_page || p.url_active_page || '',
  }));
}

/** Fetch one source's jobs; per-ATS dispatch. Throws on transport/HTTP error. */
export async function fetchSource(src: AtsSource): Promise<JobRow[]> {
  switch (src.ats) {
    case 'greenhouse':
      return fetchGreenhouse(src);
    case 'lever':
      return fetchLever(src);
    case 'breezy':
      return fetchBreezy(src);
    case 'comeet':
      return fetchComeet(src);
  }
}

/**
 * Fetch every configured ATS source and upsert into job_postings. Per-source
 * failures are isolated — one org's outage does not abort the run.
 *
 * ⚠ This writes to the DB via upsertJobs. Like the JewishJobs scraper it must only
 * run behind the gated cron (JOBS_SCRAPER_ENABLED) or a human-invoked trigger —
 * never ad-hoc against the production database. Use scripts/spike-ats-jobs.ts for a
 * no-DB dry run.
 */
export async function runAtsScrape(
  sources: AtsSource[] = ATS_SOURCES,
): Promise<{ fetched: number; inserted: number }> {
  const runStart = Date.now();
  const all: JobRow[] = [];

  for (const src of sources) {
    try {
      const rows = await fetchSource(src);
      all.push(...rows);
      log.info({ token: src.token, ats: src.ats, count: rows.length }, 'Source fetched');
    } catch (err) {
      log.warn({ err, token: src.token, ats: src.ats }, 'Source failed — skipping');
    }
  }

  const { inserted } = await upsertJobs(all);
  log.info(
    { sources: sources.length, fetched: all.length, inserted, duration_ms: Date.now() - runStart },
    'ATS run complete',
  );
  return { fetched: all.length, inserted };
}
