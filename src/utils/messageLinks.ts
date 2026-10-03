// The single definition of "a link in a chat message" and its analytics key
// (quick 261003-nfu).
//
// This file is BYTE-IDENTICAL to tribelife-mobile/utils/messageLinks.ts.
// Edit both copies together, and run BOTH gates before and after any change:
//   cd tribelife-backend && node --no-warnings scripts/verify-link-analytics.mjs
//   cd tribelife-mobile  && node --no-warnings scripts/verify-link-clicks.mjs
// Each gate byte-compares the two copies, so a one-sided edit fails.
//
// Zero imports and only erasable TypeScript syntax (no enums, no namespaces),
// so Node gates and both TS configs can load it. No DOM lib is needed.
//
// LINK_URL_REGEX, findLinkSpans and firstNonYouTubeUrl reproduce MessageBubble's
// original link rendering. youTubeCardIds reproduces utils/youtube.ts
// extractYouTubeIds. linkKey is the analytics identity: every spelling of the
// same link maps to one key, so the inline text, the preview card and the
// YouTube card of a message all count toward the same row.

// ── Constants ────────────────────────────────────────────────────────────────

export const LINK_KEY_MAX_LENGTH = 2048;
export const MESSAGE_LINKS_MAX = 20;
export const YOUTUBE_CARDS_MAX = 3;

// Matches: full URLs (http/https), www-prefixed URLs, and bare domains with a
// recognised TLD (e.g. tribelife.app, example.com/path). The TLD list is
// curated to keep false positives ("Dr.Smith", "version2.0") low while
// covering the common cases users actually paste.
export const LINK_URL_REGEX = /\b(?:https?:\/\/[^\s<>]+|www\.[^\s<>]+|(?:[a-zA-Z0-9][a-zA-Z0-9-]*\.)+(?:com|net|org|edu|gov|mil|io|app|co|ai|dev|me|tv|info|biz|us|uk|de|fr|jp|au|nz|il|eu|ca|in|br|cn|ru|tech|online|store|site|xyz|ly|so|fm|to|cc|gg|club|news|blog)(?:\/[^\s<>]*)?)/gi;

// Trailing punctuation that is almost never part of the URL.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

// Every YouTube URL form that unfurls as a card (same pattern as utils/youtube.ts).
const YOUTUBE_URL_PATTERN =
  /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;

// The same alternation anchored at the start of host+path+query (scheme and
// www already removed), capturing the 11-char video id.
const YOUTUBE_KEY_PATTERN =
  /^(?:m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// scheme://host, path, ?query, #fragment
const URL_PARTS_PATTERN = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i;

// ── Types ────────────────────────────────────────────────────────────────────

export type LinkSpan = { index: number; text: string; url: string };
export type MessageLinkSource = 'text' | 'youtube';
export type MessageLink = { key: string; index: number; url: string; source: MessageLinkSource };

// ── Link spans (what MessageBubble linkifies) ────────────────────────────────

// Hosts whose links unfurl as a YouTube card, so they are excluded from the
// generic link-preview card.
export function isYouTubeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be';
}

// Every linkified span in `content`, in order. Skips bare domains that are the
// host part of an email address, trims trailing punctuation, and normalizes a
// scheme-less match to https://. The regex keeps scanning after the FULL match.
export function findLinkSpans(content: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  if (!content) return spans;
  const re = new RegExp(LINK_URL_REGEX.source, LINK_URL_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > 0 && content[match.index - 1] === '@') continue;
    let text = match[0];
    const trailing = text.match(TRAILING_PUNCTUATION);
    if (trailing) text = text.slice(0, -trailing[0].length);
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    spans.push({ index: match.index, text, url });
  }
  return spans;
}

// The first http(s) URL in `content` that is NOT a YouTube link, or null.
export function firstNonYouTubeUrl(content: string): string | null {
  for (const span of findLinkSpans(content)) {
    try {
      if (isYouTubeHost(new URL(span.url).hostname)) continue;
    } catch {
      continue;
    }
    return span.url;
  }
  return null;
}

// ── YouTube cards ────────────────────────────────────────────────────────────

// Distinct video ids with the index of their first match, first-seen order,
// capped at YOUTUBE_CARDS_MAX.
function youTubeCardMatches(content: string): { id: string; index: number }[] {
  const out: { id: string; index: number }[] = [];
  if (!content) return out;
  const re = new RegExp(YOUTUBE_URL_PATTERN.source, YOUTUBE_URL_PATTERN.flags);
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, index: match.index });
    if (out.length >= YOUTUBE_CARDS_MAX) break;
  }
  return out;
}

// Distinct 11-char YouTube ids in first-seen order (equals extractYouTubeIds).
export function youTubeCardIds(content: string): string[] {
  return youTubeCardMatches(content).map((m) => m.id);
}

export function youTubeKey(id: string): string {
  return `https://youtube.com/watch?v=${id}`;
}

// ── Analytics key ────────────────────────────────────────────────────────────

// Normalized identity of a link: https scheme, lowercase host without
// userinfo / default port / trailing dot / www, no trailing slashes on the
// path, no empty query, no fragment. Path and query keep their case. Every
// YouTube video form collapses to youTubeKey(id). Null when the input is not a
// usable link or the key would exceed LINK_KEY_MAX_LENGTH.
export function linkKey(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parts = absolute.match(URL_PARTS_PATTERN);
  if (!parts) return null;

  let host = parts[1].toLowerCase();
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  host = host.replace(/:(?:80|443)$/, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  host = host.replace(/^www\./, '');
  if (!host) return null;

  const path = (parts[2] ?? '').replace(/\/+$/, '');
  const query = parts[3] && parts[3] !== '?' ? parts[3] : '';

  if (isYouTubeHost(host)) {
    const yt = (host + path + query).match(YOUTUBE_KEY_PATTERN);
    if (yt) return youTubeKey(yt[1]);
  }

  const key = `https://${host}${path}${query}`;
  return key.length > LINK_KEY_MAX_LENGTH ? null : key;
}

// ── Links in a message ───────────────────────────────────────────────────────

// The links in a message, in order: every linkified span with a usable key
// (source 'text'), plus every YouTube card (source 'youtube', which also covers
// a bare youtu.be/<id> that is not linkified). Sorted by position, 'text'
// before 'youtube' at the same position, de-duplicated by key, capped.
export function messageLinks(content: string): MessageLink[] {
  if (!content) return [];
  const all: MessageLink[] = [];
  for (const span of findLinkSpans(content)) {
    const key = linkKey(span.url);
    if (key !== null) all.push({ key, index: span.index, url: span.url, source: 'text' });
  }
  for (const card of youTubeCardMatches(content)) {
    const key = youTubeKey(card.id);
    all.push({ key, index: card.index, url: key, source: 'youtube' });
  }
  all.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    if (a.source === b.source) return 0;
    return a.source === 'text' ? -1 : 1;
  });
  const seen = new Set<string>();
  const links: MessageLink[] = [];
  for (const link of all) {
    if (seen.has(link.key)) continue;
    seen.add(link.key);
    links.push(link);
    if (links.length >= MESSAGE_LINKS_MAX) break;
  }
  return links;
}

export function messageLinkKeys(content: string): string[] {
  return messageLinks(content).map((l) => l.key);
}

// The original url of the first span that keys to this video, else the
// canonical key. Either way it normalizes to the same analytics key.
export function youTubeCardUrl(content: string, videoId: string): string {
  const target = youTubeKey(videoId);
  for (const span of findLinkSpans(content)) {
    if (linkKey(span.url) === target) return span.url;
  }
  return target;
}
