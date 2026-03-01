import OpenAI from 'openai';

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
- isAppropriate = false if the beacon contains: hate speech, sexual content, illegal activity solicitation, personal contact info, spam/advertising links, or threatening language.
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
export async function compareBeacons(
  intentA: string,
  keywordsA: string[],
  intentB: string,
  keywordsB: string[]
): Promise<MatchResult> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `You are a semantic matching engine for a community app.

Determine if these two community beacons are a meaningful match (someone who could help the other or share mutual interest).

Beacon A: "${intentA}"
Keywords A: ${keywordsA.join(', ')}

Beacon B: "${intentB}"
Keywords B: ${keywordsB.join(', ')}

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
