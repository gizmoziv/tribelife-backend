// Pure, DB-free share-preview policy for group invite links (/g/:slug).
// Deliberately imports nothing from ../db, express, or the logger so
// scripts/verify-share-preview.ts can exercise it entirely offline with no
// environment/DB connection. See PLAN 260927-bi0 for the full spec.

// Same 5-character escaping as the private helper in src/routes/support.ts
// (do not modify that file — this is an independent, DB-free copy).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The exact strings shipped today for /g/:slug's web-UA branch
// (deepLinkFallback.ts lines 267-269) — used whenever there's no group,
// the group is archived, or the name normalizes to empty.
export const GROUP_SHARE_GENERIC = {
  heading: 'Join this group on TribeLife',
  subtext: 'TribeLife is a mobile app — download it on your phone to join the conversation.',
} as const;

export const OG_DESCRIPTION_MAX = 200;

export type GroupShareSource = {
  name: string | null;
  description: string | null;
  isPublic: boolean;
  archived: boolean;
};

// Strip C0/DEL control chars, collapse whitespace runs to a single space, trim.
// Order matters: strip non-whitespace control chars FIRST, leaving \t \n \v \f
// \r intact so the whitespace-collapse step below still sees them as run
// boundaries — stripping them before collapsing would fuse adjacent words
// (e.g. "runs\n\nby" -> "runsby" instead of "runs by").
function normalizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

// Cap at maxCodePoints CODE POINTS (never splitting a surrogate pair) and
// append a single '…' when truncated.
function capCodePoints(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) return text;
  return codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join('') + '…';
}

// Builds the { heading, subtext } copy used by both the web-UA landing page
// and the mobile-UA interstitial's OG meta. isPublic is kept on the source
// type and threaded through even though it no longer gates the description
// (explicit product decision, confirmed with the user during planning: the
// description is shown for public AND private groups) — a future tightening
// is then a one-line change here instead of a re-plumb.
export function groupShareCopy(src: GroupShareSource | null): { heading: string; subtext: string } {
  if (src == null || src.archived) {
    return { ...GROUP_SHARE_GENERIC };
  }

  const name = src.name != null ? normalizeText(src.name) : '';
  const heading = name ? `Join ${name} on TribeLife` : GROUP_SHARE_GENERIC.heading;

  const description = src.description != null ? normalizeText(src.description) : '';
  const subtext = description
    ? capCodePoints(description, OG_DESCRIPTION_MAX)
    : GROUP_SHARE_GENERIC.subtext;

  return { heading, subtext };
}

// Renders the 10 social-meta lines renderDownloadLanding emits today
// (name="description", og:type, og:title, og:description, og:image, og:url,
// twitter:card, twitter:title, twitter:description, twitter:image). Every
// user-authored attribute value is escaped.
export function renderSocialMeta(opts: {
  canonicalUrl: string;
  title: string;
  description: string;
  image: string;
}): string {
  const title = escapeHtml(opts.title);
  const description = escapeHtml(opts.description);
  const canonicalUrl = escapeHtml(opts.canonicalUrl);
  const image = escapeHtml(opts.image);
  return [
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:url" content="${canonicalUrl}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join('\n');
}
