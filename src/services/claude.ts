import OpenAI from 'openai';

// ── Message Content Filter ─────────────────────────────────────────────────
// Synchronous keyword blocklist for real-time chat moderation (Apple Guideline 1.2).
// Intentionally avoids AI calls to keep latency at zero.

export interface ModerationResult {
  isAllowed: boolean;
  reason?: string;
}

// Core blocklist — slurs, extreme profanity, hate speech triggers.
// Using word-boundary regex so "assassin" doesn't match "ass".
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Hate speech / slurs
  { pattern: /\bn[i1!][g9][g9][e3]r\b/i, reason: 'Hate speech detected' },
  { pattern: /\bn[i1!][g9]{2}[ae3]\b/i, reason: 'Hate speech detected' },
  { pattern: /\bf[a@]g+[o0]t\b/i, reason: 'Slur detected' },
  { pattern: /\bf[a@]gg?[ie]?\b/i, reason: 'Slur detected' },
  { pattern: /\bk[i1][k]e\b/i, reason: 'Slur detected' },
  { pattern: /\bch[i1]nk\b/i, reason: 'Slur detected' },
  { pattern: /\bsp[i1][ck]\b/i, reason: 'Slur detected' },
  { pattern: /\btrannie\b/i, reason: 'Slur detected' },
  { pattern: /\br[e3]t[a@]rd\b/i, reason: 'Slur detected' },
  // Threats / violence
  { pattern: /\bkill\s+your?self\b/i, reason: 'Violent threat detected' },
  { pattern: /\bi\s+will\s+kill\s+you\b/i, reason: 'Violent threat detected' },
  { pattern: /\bi\s+w[i1]ll\s+[hk][u4][r][t]\s+you\b/i, reason: 'Violent threat detected' },
  { pattern: /\bkys\b/i, reason: 'Harmful content detected' },
  // Extreme profanity (l33t evasions included)
  { pattern: /\bc[u4][n][t]\b/i, reason: 'Profanity detected' },
  { pattern: /\b[f][u4@][c(][k]\b/i, reason: 'Profanity detected' },
  { pattern: /\bf+[u4@]+[c(]+k+\b/i, reason: 'Profanity detected' },
  { pattern: /\bsh[i1!][t]\b/i, reason: 'Profanity detected' },
  { pattern: /\b[a@][s$][s$]h[o0][l1][e3]\b/i, reason: 'Profanity detected' },
  { pattern: /\bb[i1][t][c(][h]\b/i, reason: 'Profanity detected' },
  // Self-harm
  { pattern: /\bsu[i1][c(][i1]d[e3]\b/i, reason: 'Self-harm reference detected' },
  { pattern: /\bcut\s+myself\b/i, reason: 'Self-harm reference detected' },
  // Sexual content
  { pattern: /\bcp\b.*\bporn\b/i, reason: 'Illegal sexual content detected' },
  { pattern: /\bchild\s+porn/i, reason: 'Illegal sexual content detected' },
  { pattern: /\bpedoph/i, reason: 'Illegal sexual content detected' },
];

/**
 * Synchronous content filter for real-time chat messages.
 * Returns immediately — no async/AI calls.
 */
export function moderateMessage(content: string): ModerationResult {
  const normalized = content.toLowerCase();

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return { isAllowed: false, reason };
    }
  }

  return { isAllowed: true };
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface BeaconAnalysis {
  isAppropriate: boolean;
  flagReason?: string;
  parsedIntent: string;       // Normalized description of what the user is seeking/offering
  category: string;           // e.g. "childcare", "entertainment", "real_estate", "services"
  intentType: 'seeking' | 'offering' | 'both';
  keywords: string[];         // Key matching terms extracted
}

/**
 * Analyze a beacon for appropriateness and extract structured intent.
 * Single call does both moderation and NLP parsing.
 */
export async function analyzeBeacon(rawText: string): Promise<BeaconAnalysis> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are a content moderator and NLP parser for TribeLife, a community platform.

Analyze this beacon (a short community request or offer):
"${rawText}"

Respond with valid JSON only (no markdown, no explanation) in this exact shape:
{
  "isAppropriate": boolean,
  "flagReason": string | null,
  "parsedIntent": string,
  "category": string,
  "intentType": "seeking" | "offering" | "both",
  "keywords": string[]
}

Rules:
- isAppropriate = false if the beacon contains: hate speech, violence or threats, sexual or nude content, illegal activity or drug solicitation, weapons or firearms sales, gambling, personal contact info (phone/email/address), spam/advertising links, discriminatory language, self-harm references, or any content that would violate Apple App Store or Google Play guidelines.
- flagReason = concise reason if isAppropriate is false, else null.
- parsedIntent = a clean, normalized 1-2 sentence description of the intent. Correct typos. Remove personal info.
- category = one of: childcare, education, entertainment, sports, real_estate, services, social, pets, transportation, health, food, other.
- intentType = "seeking" (looking for something), "offering" (providing something), "both".
- keywords = 3-8 key terms that capture the essence for matching purposes.

Examples of appropriate beacons:
- "looking for a babysitter on weekends" → seeking, childcare
- "I have an off-market house for sale" → offering, real_estate
- "want to find people to play chess" → seeking/both, entertainment
- "need someone to walk my dog" → seeking, pets`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  try {
    return JSON.parse(raw) as BeaconAnalysis;
  } catch {
    // Fallback: flag as inappropriate to be safe
    return {
      isAppropriate: false,
      flagReason: 'Unable to analyze beacon content',
      parsedIntent: rawText,
      category: 'other',
      intentType: 'seeking',
      keywords: [],
    };
  }
}

export interface MatchResult {
  score: number;       // 0–1 similarity
  reason: string;     // Human-readable explanation
  isMatch: boolean;   // true if score >= 0.65
}

/**
 * Compare two beacon intents and return a similarity score + explanation.
 * Called during daily batch matching.
 */
function sanitize(s: string): string {
  // Strip control chars (except \n \r \t) that can corrupt JSON payloads
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export async function compareBeacons(
  intentA: string,
  keywordsA: string[],
  intentB: string,
  keywordsB: string[]
): Promise<MatchResult> {
  const safeIntentA = sanitize(intentA);
  const safeIntentB = sanitize(intentB);
  const safeKeywordsA = keywordsA.map(sanitize);
  const safeKeywordsB = keywordsB.map(sanitize);
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `You are a semantic matching engine for a community app.

Determine if these two community beacons are a meaningful match (someone who could help the other or share mutual interest).

Beacon A: "${safeIntentA}"
Keywords A: ${safeKeywordsA.join(', ')}

Beacon B: "${safeIntentB}"
Keywords B: ${safeKeywordsB.join(', ')}

Respond with valid JSON only:
{
  "score": number between 0 and 1,
  "reason": "one sentence explaining why or why not they match",
  "isMatch": boolean
}

isMatch = true if score >= 0.65. A match means one person can meaningfully help or connect with the other, or they share a mutual interest worth connecting over.`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  try {
    return JSON.parse(raw) as MatchResult;
  } catch {
    return { score: 0, reason: 'Unable to compare', isMatch: false };
  }
}
