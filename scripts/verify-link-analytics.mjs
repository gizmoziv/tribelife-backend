// verify-link-analytics.mjs
//
// OFFLINE ONLY — never imported by app code. Exercises the pure link-analytics
// helpers in src/utils/messageLinks.ts (what counts as a "link" in a chat
// message, and its normalized key) and src/utils/linkClickStats.ts (write
// decision, per-link aggregation, group predicate, missing-table detection).
// No network, no Redis, no database: both modules have zero imports.
//
// PARITY with the mobile client: the ORACLE below is a frozen copy of the link
// logic in tribelife-mobile/components/ui/chat/MessageBubble.tsx as of
// 2026-10-03 (URL_REGEX, parseContent's URL loop, isYouTubeHost,
// firstNonYouTubeUrl). findLinkSpans / firstNonYouTubeUrl must reproduce it
// exactly, and youTubeCardIds must equal the mobile extractYouTubeIds
// (tribelife-mobile/utils/youtube.ts, imported for real).
//
// DRIFT GUARD: src/utils/messageLinks.ts must stay BYTE-IDENTICAL to
// tribelife-mobile/utils/messageLinks.ts. When the mobile repo is checked out
// as a sibling, this gate compares the two files and fails on any difference.
// When the mobile copy is absent it prints a note on stderr and skips only that
// check (never a failure). Run BOTH gates before changing either copy.
//
// Usage (from tribelife-backend/): node --no-warnings scripts/verify-link-analytics.mjs
//   Optional args: [path/to/messageLinks.ts] [path/to/linkClickStats.ts]
//   [path/to/mobile/utils/youtube.ts] [path/to/mobile/utils/messageLinks.ts],
//   resolved against the current working directory. Defaults are relative to
//   this script (tribelife-backend/scripts/).
//   Requires Node v22.18+ (built-in TypeScript type stripping).
//
// Planner-authored gate for quick task 261003-nfu. The committed copy in
// tribelife-backend/scripts/ must stay byte-identical to the planning copy.
// Prints LINK_ANALYTICS_OK on success, LINK_ANALYTICS_FAIL <case...> otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const linksPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../src/utils/messageLinks.ts');
const statsPath = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(here, '../src/utils/linkClickStats.ts');
const ytPath = process.argv[4] ? path.resolve(process.argv[4]) : path.resolve(here, '../../tribelife-mobile/utils/youtube.ts');
const mobileLinksPath = process.argv[5] ? path.resolve(process.argv[5]) : path.resolve(here, '../../tribelife-mobile/utils/messageLinks.ts');
const fails = [];
const ok = (c, n) => { if (!c) fails.push(n); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pure = (src) => !/^\s*import\s/m.test(src) && !/require\(/.test(src);

ok(pure(fs.readFileSync(linksPath, 'utf8')), 'pure:links');
ok(pure(fs.readFileSync(statsPath, 'utf8')), 'pure:stats');
if (fs.existsSync(mobileLinksPath)) {
  ok(Buffer.compare(fs.readFileSync(linksPath), fs.readFileSync(mobileLinksPath)) === 0, 'parity:mobilebytes');
} else {
  console.error('[verify-link-analytics] note: ' + mobileLinksPath + ' not found; mobile byte-parity check skipped');
}
const L = await import(pathToFileURL(linksPath).href);
const S = await import(pathToFileURL(statsPath).href);
const Y = await import(pathToFileURL(ytPath).href);
const fnL = ['isYouTubeHost', 'findLinkSpans', 'firstNonYouTubeUrl', 'youTubeCardIds', 'youTubeKey', 'linkKey', 'messageLinks', 'messageLinkKeys', 'youTubeCardUrl'];
const fnS = ['isLinkAnalyticsConversation', 'decideLinkClickWrite', 'linkClickDedupeCutoff', 'aggregateLinkClicks', 'isMissingRelationError'];
ok(fnL.every((f) => typeof L[f] === 'function'), 'exports:links');
ok(fnS.every((f) => typeof S[f] === 'function'), 'exports:stats');
ok(typeof Y.extractYouTubeIds === 'function', 'exports:youtube');
if (fails.length) { console.log('LINK_ANALYTICS_FAIL ' + fails.join(' ')); process.exit(1); }

ok(L.LINK_KEY_MAX_LENGTH === 2048 && L.MESSAGE_LINKS_MAX === 20 && L.YOUTUBE_CARDS_MAX === 3, 'const:links');
ok(S.LINK_CLICK_DEDUPE_MS === 2000 && S.LINK_CLICK_MAX_PER_USER_PER_MESSAGE === 50, 'const:stats');
ok(eq([...S.LINK_CLICK_SOURCES], ['text', 'preview', 'youtube']) && eq([...S.LINK_CLICK_PLATFORMS], ['ios', 'android']), 'const:enums');

// ── ORACLE: frozen copy of MessageBubble.tsx link logic (2026-10-03) ─────────
const O_URL_REGEX = /\b(?:https?:\/\/[^\s<>]+|www\.[^\s<>]+|(?:[a-zA-Z0-9][a-zA-Z0-9-]*\.)+(?:com|net|org|edu|gov|mil|io|app|co|ai|dev|me|tv|info|biz|us|uk|de|fr|jp|au|nz|il|eu|ca|in|br|cn|ru|tech|online|store|site|xyz|ly|so|fm|to|cc|gg|club|news|blog)(?:\/[^\s<>]*)?)/gi;
function oIsYouTubeHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be';
}
function oFirstNonYouTubeUrl(content) {
  if (!content) return null;
  O_URL_REGEX.lastIndex = 0;
  let match;
  while ((match = O_URL_REGEX.exec(content)) !== null) {
    if (match.index > 0 && content[match.index - 1] === '@') continue;
    let raw = match[0];
    const trailingMatch = raw.match(/[.,;:!?)\]}'"]+$/);
    if (trailingMatch) raw = raw.slice(0, -trailingMatch[0].length);
    const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      if (oIsYouTubeHost(new URL(target).hostname)) continue;
    } catch {
      continue;
    }
    return target;
  }
  return null;
}
function oSpans(content) {
  const out = [];
  let match;
  O_URL_REGEX.lastIndex = 0;
  while ((match = O_URL_REGEX.exec(content)) !== null) {
    if (match.index > 0 && content[match.index - 1] === '@') continue;
    let url = match[0];
    const trailingMatch = url.match(/[.,;:!?)\]}'"]+$/);
    if (trailingMatch) url = url.slice(0, -trailingMatch[0].length);
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    out.push({ index: match.index, text: url, url: target });
  }
  return out;
}

ok(L.LINK_URL_REGEX instanceof RegExp && L.LINK_URL_REGEX.source === O_URL_REGEX.source && L.LINK_URL_REGEX.flags === 'gi', 'parity:regex');

const V = 'dQw4w9WgXcQ';
const W = 'abcDEF12_-x';
const CORPUS = [
  '', 'hello world', 'see tribelife.app/g/shabbat-dinner!', 'https://tribelife.app/g/shabbat-dinner',
  'mail bob@example.com now', 'Dr.Smith said version2.0 is out', 'www.example.org/path?q=1#top.',
  '(see https://example.com/a_(b))', 'two: https://a.com/x, http://b.io/y; done', 'quote "https://c.dev/z"',
  `watch https://youtu.be/${V}!`, `https://www.youtube.com/watch?v=${V}&t=30s and youtube.com/shorts/${W}`,
  `bare youtu.be/${V} here`, `m.youtube.com/watch?feature=share&v=${V}`, `https://www.youtube.com/embed/${W}?rel=0`,
  'https://www.youtube.com/channel/UCabc', 'שלום tribelife.app/u/david ולהתראות', 'https://example.com/<tag>',
  'ends with dot example.com.', 'x.io/ and y.co/', '@handle tribelife.app @other', 'https://)', 'www.)',
  'HTTPS://EXAMPLE.COM/UP', 'a.com/x a.com/x A.COM/x', 'link:https://news.site/today', 'ftp://files.example.net/x',
  'tel 123.456.7890', 'https://example.com:443/x and http://example.com:80/x and https://example.com:8080/x',
  'youtu.be/AAAAAAAAAAA https://youtu.be/BBBBBBBBBBB youtube.com/shorts/CCCCCCCCCCC https://www.youtube.com/watch?v=DDDDDDDDDDD',
];
let seed = 20261003;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const TOK = ['https://', 'http://', 'www.', 'tribelife.app', 'example.com', 'news.co', '/g/x', '/a/b/', '?a=1&b=2', '#f', '.', ',', ')', '!', '"', "'", ' ', ' ', '\n', '@', 'bob@', `youtu.be/${V}`, `youtube.com/watch?v=${W}`, `https://www.youtube.com/shorts/${V}`, 'Dr.Smith', 'v2.0', 'שלום', 'a.co', 'x.io/', '<', '>', ']', '}', 'HTTPS://', 'WWW.', 'Example.COM'];
const FUZZ = [];
for (let i = 0; i < 600; i++) { let s = ''; const n = 1 + rnd(12); for (let j = 0; j < n; j++) s += TOK[rnd(TOK.length)]; FUZZ.push(s); }

for (const [i, c] of [...CORPUS, ...FUZZ].entries()) {
  if (!eq(L.findLinkSpans(c), oSpans(c))) { ok(false, 'parity:spans' + i); break; }
}
for (const [i, c] of [...CORPUS, ...FUZZ].entries()) {
  if (L.firstNonYouTubeUrl(c) !== oFirstNonYouTubeUrl(c)) { ok(false, 'parity:preview' + i); break; }
}
for (const [i, c] of [...CORPUS, ...FUZZ].entries()) {
  if (!eq(L.youTubeCardIds(c), Y.extractYouTubeIds(c))) { ok(false, 'parity:youtube' + i); break; }
}
ok(L.findLinkSpans('mail bob@example.com now').length === 0, 'spans:email');
ok(eq(L.findLinkSpans('see tribelife.app/g/shabbat-dinner!'), [{ index: 4, text: 'tribelife.app/g/shabbat-dinner', url: 'https://tribelife.app/g/shabbat-dinner' }]), 'spans:trim');

// ── linkKey ──────────────────────────────────────────────────────────────────
const K = L.linkKey;
const YK = `https://youtube.com/watch?v=${V}`;
ok(K('https://tribelife.app/g/shabbat-dinner') === 'https://tribelife.app/g/shabbat-dinner', 'key:plain');
ok(K('http://www.TribeLife.APP/g/shabbat-dinner/') === 'https://tribelife.app/g/shabbat-dinner', 'key:scheme-www-case-slash');
ok(K('tribelife.app') === 'https://tribelife.app' && K('https://tribelife.app/') === 'https://tribelife.app', 'key:root');
ok(K('https://example.com/Path/Case?b=2&a=1#frag') === 'https://example.com/Path/Case?b=2&a=1', 'key:pathcase-query-fragment');
ok(K('https://example.com/?') === 'https://example.com' && K('https://example.com#x') === 'https://example.com', 'key:emptyquery');
ok(K('https://example.com:443/x') === 'https://example.com/x' && K('http://example.com:80/x') === 'https://example.com/x' && K('https://example.com:8080/x') === 'https://example.com:8080/x', 'key:port');
ok(K('https://user@example.com/x') === 'https://example.com/x' && K('https://example.com./x') === 'https://example.com/x', 'key:userinfo-dot');
ok([`https://youtu.be/${V}`, `https://www.youtube.com/watch?v=${V}&t=30s`, `youtube.com/watch?v=${V}`, `https://m.youtube.com/watch?feature=share&v=${V}`, `https://www.youtube.com/embed/${V}`, `youtube.com/shorts/${V}`, `HTTPS://YOUTU.BE/${V}`, `http://www.youtube.com/v/${V}`].every((u) => K(u) === YK), 'key:youtube');
ok(K('https://www.youtube.com/channel/UCabc') === 'https://youtube.com/channel/UCabc', 'key:youtube-nonvideo');
ok(K('') === null && K('   ') === null && K('https://') === null, 'key:empty');
ok(K('https://example.com/' + 'a'.repeat(2100)) === null && K('https://example.com/' + 'a'.repeat(2000)) === 'https://example.com/' + 'a'.repeat(2000), 'key:maxlen');
ok(L.youTubeKey(V) === YK, 'key:ytkey');

// ── messageLinks / messageLinkKeys / youTubeCardUrl ─────────────────────────
const MK = L.messageLinkKeys;
ok(eq(MK('see tribelife.app/g/shabbat-dinner and https://example.com/a.'), ['https://tribelife.app/g/shabbat-dinner', 'https://example.com/a']), 'links:order');
ok(eq(MK(`first https://example.com then https://youtu.be/${V} and https://www.youtube.com/watch?v=${V}`), ['https://example.com', YK]), 'links:ytdedupe');
ok(eq(MK('a.com/x a.com/x A.COM/x http://www.a.com/x/'), ['https://a.com/x']), 'links:dedupe');
ok(eq(MK('mail me at bob@example.com'), []) && eq(MK('hello world'), []) && eq(MK(''), []), 'links:none');
const bare = L.messageLinks(`watch youtu.be/${V} now`);
ok(bare.length === 1 && bare[0].key === YK && bare[0].source === 'youtube' && bare[0].index === 6, 'links:bareyoutube');
const txt = L.messageLinks(`go https://youtu.be/${V}`);
ok(txt.length === 1 && txt[0].source === 'text' && txt[0].url === `https://youtu.be/${V}`, 'links:textwins');
const many = Array.from({ length: 25 }, (_, i) => `https://site${i}.com/p`).join(' ');
ok(eq(MK(many), Array.from({ length: 20 }, (_, i) => `https://site${i}.com/p`)), 'links:cap20');
const ids4 = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'DDDDDDDDDDD'];
ok(eq(MK(ids4.map((id) => `youtu.be/${id}`).join(' ')), ids4.slice(0, 3).map((id) => L.youTubeKey(id))), 'links:ytcap3');
ok(eq(L.youTubeCardIds(ids4.map((id) => `youtu.be/${id}`).join(' ')), ids4.slice(0, 3)), 'cards:cap3');
ok(eq(MK(`intro youtu.be/${V} then https://example.com/x`), [YK, 'https://example.com/x']), 'links:mixedorder');
ok(L.youTubeCardUrl(`watch https://youtu.be/${V}!`, V) === `https://youtu.be/${V}`, 'cardurl:original');
ok(L.youTubeCardUrl(`watch youtu.be/${V}`, V) === YK, 'cardurl:fallback');
for (const [i, c] of [...CORPUS, ...FUZZ].entries()) {
  const keys = MK(c);
  const cards = L.youTubeCardIds(c);
  if (keys.length < 20 && !cards.every((id) => keys.includes(K(L.youTubeCardUrl(c, id))))) { ok(false, 'links:cardcovered' + i); break; }
  if (!L.findLinkSpans(c).every((s) => { const k = K(s.url); return k === null || keys.length >= 20 || keys.includes(k); })) { ok(false, 'links:spancovered' + i); break; }
}

// ── linkClickStats ───────────────────────────────────────────────────────────
const G = S.isLinkAnalyticsConversation;
ok(G({ isGroup: true }) === true && G({ isGroup: false }) === false && G({ isGroup: null }) === false && G(null) === false && G(undefined) === false, 'group:predicate');
const D = S.decideLinkClickWrite;
ok(D({ isSender: true, priorClicks: 0, hasRecentSameUrlClick: false }) === 'sender', 'write:sender');
ok(D({ isSender: true, priorClicks: 99, hasRecentSameUrlClick: true }) === 'sender', 'write:senderfirst');
ok(D({ isSender: false, priorClicks: 49, hasRecentSameUrlClick: false }) === 'record', 'write:record');
ok(D({ isSender: false, priorClicks: 50, hasRecentSameUrlClick: false }) === 'capped', 'write:cap');
ok(D({ isSender: false, priorClicks: 50, hasRecentSameUrlClick: true }) === 'capped', 'write:capfirst');
ok(D({ isSender: false, priorClicks: 3, hasRecentSameUrlClick: true }) === 'duplicate', 'write:dup');
const cut = S.linkClickDedupeCutoff(new Date(10000));
ok(cut instanceof Date && cut.getTime() === 8000, 'write:cutoff');
const A = S.aggregateLinkClicks;
const a1 = A(['A', 'B', 'C'], [
  { url: 'A', userId: 2, clicks: 3 }, { url: 'A', userId: 3, clicks: 1 }, { url: 'B', userId: 2, clicks: 1 },
  { url: 'A', userId: 1, clicks: 5 }, { url: 'Z', userId: 2, clicks: 4 },
], 1);
ok(eq(a1, [{ url: 'A', clicks: 4, uniqueClickers: 2 }, { url: 'B', clicks: 1, uniqueClickers: 1 }, { url: 'C', clicks: 0, uniqueClickers: 0 }]), 'agg:basic');
ok(eq(A(['A'], [{ url: 'A', userId: 2, clicks: 10 }], 1), [{ url: 'A', clicks: 10, uniqueClickers: 1 }]), 'agg:repeat');
ok(eq(A(['B', 'A', 'B'], [{ url: 'A', userId: 2, clicks: 1 }], 1), [{ url: 'B', clicks: 0, uniqueClickers: 0 }, { url: 'A', clicks: 1, uniqueClickers: 1 }]), 'agg:order-dedupe');
ok(eq(A(['A'], [{ url: 'A', userId: 1, clicks: 2 }], null), [{ url: 'A', clicks: 2, uniqueClickers: 1 }]), 'agg:nullsender');
ok(eq(A(['A'], [{ url: 'A', userId: 2, clicks: -3 }, { url: 'A', userId: 3, clicks: NaN }, { url: 'A', userId: 4, clicks: 2.7 }], 1), [{ url: 'A', clicks: 2, uniqueClickers: 1 }]), 'agg:sanitize');
ok(eq(A(['A', 'B'], [], 1), [{ url: 'A', clicks: 0, uniqueClickers: 0 }, { url: 'B', clicks: 0, uniqueClickers: 0 }]) && eq(A([], [{ url: 'A', userId: 2, clicks: 1 }], 1), []), 'agg:empty');
ok(eq(A(['A'], [{ url: 'A', userId: 2, clicks: 1 }, { url: 'A', userId: 2, clicks: 2 }], 9), [{ url: 'A', clicks: 3, uniqueClickers: 1 }]), 'agg:splitrows');
const R = S.isMissingRelationError;
const T = 'message_link_clicks';
const pgMissing = (rel) => ({ code: '42P01', message: `relation "${rel}" does not exist` });
ok(R(pgMissing(T), T) && R({ message: 'Failed query: select ...', cause: pgMissing(T) }, T) && R({ cause: { cause: pgMissing(T) } }, T), 'missing:yes');
ok(R({ code: '42P01', message: `relation "public.${T}" does not exist` }, T), 'missing:qualified');
ok(!R(pgMissing('messages'), T) && !R({ cause: pgMissing('conversation_participants') }, T) && !R(pgMissing(`${T}_daily`), T), 'missing:otherrelation');
ok(!R({ code: '42P01' }, T) && !R({ code: '23505', message: `relation "${T}" does not exist` }, T) && !R(null, T) && !R(undefined, T) && !R(new Error(`relation "${T}" does not exist`), T) && !R('42P01', T), 'missing:no');

if (fails.length) { console.log('LINK_ANALYTICS_FAIL ' + fails.join(' ')); process.exit(1); }
console.log('LINK_ANALYTICS_OK');
