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
  const href = titleAnchor.attr('href') ?? '';           // e.g. "/job/3kaetd"
  const externalRef = href.replace(/^\/job\//, '');      // e.g. "3kaetd"
  const jobUrl = `${BASE_URL}${href}`;

  if (!title || !externalRef) throw new Error('Missing title or externalRef');

  // Company
  const company = $el.find('.listColumn.company').text().trim();

  // Location (from tags — null if empty → mobile renders "Remote")
  const location = $el.find('.tags').text().trim() || null;

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
