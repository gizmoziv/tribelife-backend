import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import logger from '../../lib/logger';
import { upsertJobs } from './jobStore';

const log = logger.child({ module: 'jobs-scraper' });

// Chrome 120 UA — mirrors rssAdapter.ts to bypass bot-detection filters
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE_URL = 'https://www.jewishjobs.com';

async function fetchSearchPage(): Promise<string> {
  const res = await fetch(`${BASE_URL}/search`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseTile($: cheerio.CheerioAPI, el: AnyNode) {
  const $el = $(el);

  // Title and job URL
  const titleAnchor = $el.find('.title a#lnkJobId');
  const title = titleAnchor.text().trim();
  const href = titleAnchor.attr('href') ?? '';           // e.g. "/job/fhkyf2/director-…/il/united-states"
  // external_ref = the SHORT, stable job id only (first path segment after /job/),
  // NOT the full slug. The title/location slug can change upstream (typo fix, relocation),
  // but the id is permanent — so it's the correct idempotent dedup key. The full URL is
  // preserved separately in jobUrl below for the tap-to-open link.
  const externalRef = href.replace(/^\/job\//, '').split('/')[0];   // e.g. "fhkyf2"
  const jobUrl = `${BASE_URL}${href}`;

  if (!title || !externalRef) throw new Error('Missing title or externalRef');

  // Company + location. jewishjobs has no dedicated location element — it embeds
  // location in the company line as "{Company} - {City, ST, Country}". Split on the
  // last " - " only when the trailing segment looks like a location (has a comma),
  // so company names that themselves contain " - " aren't misread as a location.
  const companyRaw = $el.find('.listColumn.company').text().trim();
  let company = companyRaw;
  let location: string | null = null;
  const dashIdx = companyRaw.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    const tail = companyRaw.slice(dashIdx + 3).trim();
    if (tail.includes(',')) {
      company = companyRaw.slice(0, dashIdx).trim();
      location = tail;                                  // null → mobile renders "Remote"
    }
  }

  // Description abstract
  const description = $el.find('.listColumn.abstract').text().trim() || null;

  // Logo URL — prefix BASE_URL if relative path
  let logoSrc = $el.find('.listColumn.logo img').attr('src') ?? null;
  if (logoSrc && logoSrc.startsWith('/')) logoSrc = `${BASE_URL}${logoSrc}`;

  // View count — "Views: N" pattern in tile text (default 0 if absent)
  const viewCount = parseInt(
    $el.text().match(/Views:\s*(\d+)/)?.[1] ?? '0',
    10,
  );

  // Posted date — MM/DD/YYYY format as scraped (null if absent)
  const postedDate = $el.text().match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? null;

  return {
    source: 'jewishjobs' as const,
    externalRef,
    title,
    company: company || 'Unknown',
    location,
    postedDate,
    description,
    logoUrl: logoSrc,
    viewCount,
    jobUrl,
  };
}

/**
 * Fetch jewishjobs.com/search, parse all .listRow tiles via cheerio,
 * and upsert into job_postings. Per-tile failures are isolated; a single
 * bad tile does not abort the run. Structured metrics are logged on completion.
 */
export async function runJobsScrape(): Promise<void> {
  const runStart = Date.now();
  let parsed = 0;
  let skipped = 0;

  const html = await fetchSearchPage();
  const $ = cheerio.load(html);
  const tiles = $('.listRow').toArray();

  // Graceful degradation: zero tiles may indicate markup change or bot block
  if (tiles.length === 0) {
    log.warn('No .listRow tiles found — markup may have changed');
    return;
  }

  log.info({ tile_count: tiles.length }, 'Tiles found');

  const jobs = [];
  for (const el of tiles) {
    try {
      jobs.push(parseTile($, el));
      parsed++;
    } catch (err) {
      skipped++;
      log.warn({ err }, 'Skipped malformed tile');
    }
  }

  const { inserted } = await upsertJobs(jobs);
  log.info(
    { parsed, skipped, inserted, duration_ms: Date.now() - runStart },
    'Run complete',
  );
}
