/**
 * News article enrichment service.
 *
 * For each news_articles row with rephrased_title IS NULL, makes one
 * GPT-4o-mini call (JSON mode, temperature 0) that returns a 3-field JSON
 * object: { rephrasedTitle, importance, originalLanguage }. Validates
 * with Zod, then either UPDATEs the row (breaking/major) or DELETEs it
 * (routine per D-08 / ENRICH-03).
 *
 * A USD cost meter in news_config.enrichment_usage_today tracks daily
 * spend; once cents_spent >= enrichment_daily_cap_usd * 100, the breaker
 * trips and subsequent articles receive raw title + importance='major'
 * (ENRICH-07 graceful degrade per D-16).
 *
 * Decisions: D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09,
 *            D-11, D-13, D-14, D-15, D-16, D-17.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { eq, isNull, asc, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import logger from '../../lib/logger';
import { db } from '../../db';
import { newsArticles, newsOutlets, newsConfig } from '../../db/schema';
import { getConfig } from './config';

// ── Module constants ────────────────────────────
const MODEL = 'gpt-4o-mini';
const SWEEP_BATCH_LIMIT = 100;           // Pitfall 4: bound worst-case sweep duration
const LLM_MAX_TOKENS = 200;              // headlines + JSON envelope fit easily in 200 tokens
const LLM_TEMPERATURE = 0;               // deterministic rephrase (D-05)

// GPT-4o-mini pricing as of 2026-04-16 (RESEARCH.md §Key Findings verified):
//   $0.15 per 1,000,000 input tokens   → 15 cents per 1,000,000 input tokens
//   $0.60 per 1,000,000 output tokens  → 60 cents per 1,000,000 output tokens
//
// We define a "micro-cent" as 10⁻⁶ cent. Per-token rates are therefore:
//   input:  15 micro-cents/token  (= 0.000015 cent/token = 1.5 × 10⁻⁸ USD/token)
//   output: 60 micro-cents/token  (= 0.000060 cent/token = 6.0 × 10⁻⁸ USD/token)
//
// Using integer micro-cents internally avoids float drift (Pitfall 3).
// IMPORTANT: converting micro-cents → cents requires DIVIDING BY 1_000_000
// (NOT 1_000). See Task 2 cost-accounting block for the worked example.
const PRICE_INPUT_MICROCENTS_PER_TOKEN = 15;   // 15 micro-cents per input token
const PRICE_OUTPUT_MICROCENTS_PER_TOKEN = 60;  // 60 micro-cents per output token

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const log = logger.child({ module: 'news-enrichment' });

// ── Zod schema for LLM response ────────────────────────────
const EnrichmentResponse = z.object({
  rephrasedTitle: z.string().min(1),
  importance: z.enum(['breaking', 'major', 'routine']),
  // ISO 639-1 two-letter code, optional -<REGION> suffix (e.g. "en", "he", "zh-CN").
  // Pitfall 1: reject "Hebrew", "iw", "hebrew-il".
  originalLanguage: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
});
type EnrichmentResponseT = z.infer<typeof EnrichmentResponse>;

// ── Usage state (cost-cap meter) ────────────────────────────
type UsageToday = {
  date: string;            // "YYYY-MM-DD" UTC
  cents_spent: number;     // integer cents, but stored as number for JSONB simplicity
  breaker_tripped: boolean;
};

function todayUtcISO(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Reads enrichment_usage_today DIRECTLY (bypasses getConfig 60s cache —
 * the cache hides mid-sweep breaker flips per RESEARCH.md anti-patterns).
 * Applies D-15 UTC rollover inline: if stored date != today, reset counter.
 */
async function loadUsageState(): Promise<UsageToday> {
  const [row] = await db
    .select({ value: newsConfig.value })
    .from(newsConfig)
    .where(eq(newsConfig.key, 'enrichment_usage_today'))
    .limit(1);

  const today = todayUtcISO();
  const stored = (row?.value ?? null) as UsageToday | null;
  if (!stored || stored.date !== today) {
    return { date: today, cents_spent: 0, breaker_tripped: false };
  }
  return stored;
}

/**
 * Overwrites enrichment_usage_today with the current in-memory state.
 * Atomic single-statement UPDATE per §Pattern H.
 */
async function persistUsageState(usage: UsageToday): Promise<void> {
  await db.execute(sql`
    UPDATE news_config
    SET value = ${JSON.stringify(usage)}::jsonb, updated_at = NOW()
    WHERE key = 'enrichment_usage_today'
  `);
}

// ── Prompt assembly ────────────────────────────
function buildSystemPrompt(preservedTerms: string[]): string {
  return `You are an editor for a neutral news feed. For each article headline, you return a JSON object with three fields: rephrasedTitle, importance, and originalLanguage.

RULES:
1. rephrasedTitle: Rewrite the headline in a neutral, factual tone. Remove clickbait, emotional adjectives, ideological framing, and question-mark teasers. Keep it roughly the same length as the original. CRITICAL: write the rephrased headline in the SAME LANGUAGE as the original headline. Do NOT translate.
2. importance: Classify as one of:
   - "breaking": Major live events (war, attacks, deaths of heads of state, terror attacks, natural disasters)
   - "major": Significant daily news (policy announcements, diplomatic moves, economic shifts, named public figures)
   - "routine": Trivial or non-news content (sports scores, weather, gossip, lifestyle, opinion pieces, obituaries of non-public figures)
3. originalLanguage: The ISO 639-1 two-letter code of the original headline's language (e.g., "en", "he", "fr", "ar", "ru", "es", "de").

PRESERVED TERMS (keep these exact strings unchanged in rephrasedTitle; do not translate, synonym-swap, or paraphrase them):
${preservedTerms.join(', ')}

Respond with ONLY a valid JSON object. No prose, no markdown, no explanation.

Example output:
{"rephrasedTitle": "Netanyahu meets Biden to discuss Gaza ceasefire", "importance": "major", "originalLanguage": "en"}`;
}

// ── Main export: enrichUnenriched (implemented in Task 2) ────────────────
// (Task 2 will append the `export async function enrichUnenriched(parentLog: Logger) { ... }` here.)
