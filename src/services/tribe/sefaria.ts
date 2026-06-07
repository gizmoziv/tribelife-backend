/**
 * Sefaria Daf Yomi client.
 *
 * Daf Yomi is GLOBAL — the same tractate+page for every Jew worldwide on a
 * given day. No location parameter needed.
 *
 * Pure parser parseSefariaDaf(json) is exported for unit testing.
 * No DB imports. Uses global fetch (Node ES2022).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface DafYomi {
  /** Tractate name, e.g. "Chullin" */
  tractate: string;
  /** Page/daf number or label, e.g. "38" */
  page: string;
  /** Combined display string, e.g. "Chullin 38" */
  displayValue: string;
}

// ── Pure parser ────────────────────────────────────────────────────────────

interface SefariaCalendarItem {
  title?: { en?: string };
  displayValue?: { en?: string };
  url?: string;
}

interface SefariaJson {
  calendar_items?: SefariaCalendarItem[];
}

/**
 * Parse a raw Sefaria /api/calendars JSON response into DafYomi.
 * Finds the "Daf Yomi" calendar_item by its English title.
 * Returns null if not found (e.g., if the API shape changes).
 */
export function parseSefariaDaf(json: SefariaJson): DafYomi | null {
  const items: SefariaCalendarItem[] = json.calendar_items ?? [];
  const dafItem = items.find((i) => i.title?.en === 'Daf Yomi');
  if (!dafItem) return null;

  const displayValue = dafItem.displayValue?.en ?? '';
  if (!displayValue) return null;

  // "Chullin 38" → tractate="Chullin", page="38"
  const lastSpace = displayValue.lastIndexOf(' ');
  const tractate = lastSpace > 0 ? displayValue.slice(0, lastSpace) : displayValue;
  const page = lastSpace > 0 ? displayValue.slice(lastSpace + 1) : '';

  return { tractate, page, displayValue };
}

// ── Fetcher ────────────────────────────────────────────────────────────────

const SEFARIA_CALENDARS_URL = 'https://www.sefaria.org/api/calendars';

/**
 * Fetch today's Daf Yomi from Sefaria.
 * Optionally accepts a specific date for deterministic caching.
 * Throws on non-2xx so the service layer can degrade gracefully.
 */
export async function fetchDafYomi(date?: Date): Promise<DafYomi | null> {
  let url = SEFARIA_CALENDARS_URL;
  if (date) {
    url += `?year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}&day=${date.getUTCDate()}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[sefaria] calendars → HTTP ${res.status}`);
  }
  const json = (await res.json()) as SefariaJson;
  return parseSefariaDaf(json);
}
