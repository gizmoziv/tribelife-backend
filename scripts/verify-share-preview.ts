// Offline assertion script for src/lib/sharePreview.ts — the group share-link
// preview policy and HTML escaping. Mirrors the verify-unsubscribe-token.ts
// style: imports ONLY the module under test (no db, no express, no logger),
// so it is safe to run with no environment/DB connection.
import {
  escapeHtml,
  groupShareCopy,
  renderSocialMeta,
  GROUP_SHARE_GENERIC,
  OG_DESCRIPTION_MAX,
  type GroupShareSource,
} from '../src/lib/sharePreview';

const TOTAL_CASES = 12;
let passCount = 0;
const failedIds: string[] = [];

function check(id: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    passCount++;
    return;
  }
  failedIds.push(id);
  console.log(`FAIL ${id} actual=${JSON.stringify(actual)}`);
}

function src(overrides: Partial<GroupShareSource>): GroupShareSource {
  return {
    name: null,
    description: null,
    isPublic: true,
    archived: false,
    ...overrides,
  };
}

// C1: escapeHtml maps all 5 chars, ampersand first (no double-escaping).
{
  const actual = escapeHtml(`& < > " '`);
  check('C1', actual === '&amp; &lt; &gt; &quot; &#39;', actual);
}

// C2: groupShareCopy(null) returns exactly today's shipped strings.
{
  const actual = groupShareCopy(null);
  check(
    'C2',
    actual.heading === GROUP_SHARE_GENERIC.heading && actual.subtext === GROUP_SHARE_GENERIC.subtext,
    actual,
  );
}

// C3: public, non-archived, name + multi-space/newline description.
{
  const actual = groupShareCopy(
    src({ name: 'Tel Aviv Runners', description: 'Weekly  runs\n\nby the beach', isPublic: true }),
  );
  check(
    'C3',
    actual.heading === 'Join Tel Aviv Runners on TribeLife' && actual.subtext === 'Weekly runs by the beach',
    actual,
  );
}

// C4: public, description null/empty/whitespace-only -> named heading + generic subtext.
{
  const a = groupShareCopy(src({ name: 'Foo', description: null }));
  const b = groupShareCopy(src({ name: 'Foo', description: '' }));
  const c = groupShareCopy(src({ name: 'Foo', description: '   ' }));
  const ok =
    a.heading === 'Join Foo on TribeLife' && a.subtext === GROUP_SHARE_GENERIC.subtext &&
    b.heading === 'Join Foo on TribeLife' && b.subtext === GROUP_SHARE_GENERIC.subtext &&
    c.heading === 'Join Foo on TribeLife' && c.subtext === GROUP_SHARE_GENERIC.subtext;
  check('C4', ok, { a, b, c });
}

// C5: private (isPublic false) with a description -> description STILL shown
// (explicit product decision — private groups show their description too).
{
  const actual = groupShareCopy(src({ name: 'Secret Club', description: 'SECRET-DESC', isPublic: false }));
  check(
    'C5',
    actual.heading === 'Join Secret Club on TribeLife' && actual.subtext === 'SECRET-DESC',
    actual,
  );
}

// C6: archived (even public, with a description) -> full generic copy.
{
  const actual = groupShareCopy(src({ name: 'Foo', description: 'Bar', isPublic: true, archived: true }));
  check(
    'C6',
    actual.heading === GROUP_SHARE_GENERIC.heading && actual.subtext === GROUP_SHARE_GENERIC.subtext,
    actual,
  );
}

// C7: name null or whitespace-only -> generic heading.
{
  const a = groupShareCopy(src({ name: null }));
  const b = groupShareCopy(src({ name: '   ' }));
  check(
    'C7',
    a.heading === GROUP_SHARE_GENERIC.heading && b.heading === GROUP_SHARE_GENERIC.heading,
    { a, b },
  );
}

// C8: a 300-char description caps at <= 200 code points ending in '…'.
{
  const longDesc = 'x'.repeat(300);
  const actual = groupShareCopy(src({ name: 'Foo', description: longDesc }));
  const codePoints = Array.from(actual.subtext);
  check(
    'C8',
    codePoints.length === OG_DESCRIPTION_MAX && actual.subtext.endsWith('…'),
    { length: codePoints.length, tail: actual.subtext.slice(-5) },
  );
}

// C9: a description whose 200-code-point cut lands on an emoji leaves no lone
// surrogate — build a description that is 199 plain chars + an emoji (4-byte
// UTF-16 surrogate pair) so the naive string-index cut at 200 UTF-16 units
// would split the pair; Array.from-based code-point counting must not.
{
  const emoji = '\u{1F600}'; // 😀 — a surrogate pair
  const longDesc = 'x'.repeat(199) + emoji + 'y'.repeat(50);
  const actual = groupShareCopy(src({ name: 'Foo', description: longDesc }));
  const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    actual.subtext,
  );
  check('C9', !hasLoneSurrogate, actual.subtext);
}

// C10: renderSocialMeta escapes an XSS payload and includes every required tag.
{
  const html = renderSocialMeta({
    canonicalUrl: 'https://tribelife.app/g/test',
    title: '<b>x</b>',
    description: '"><script>alert(1)</script>',
    image: 'https://tribelife.app/android-chrome-512x512.png',
  });
  const hasEscaped = html.includes('&lt;script&gt;') && html.includes('&quot;&gt;');
  const hasNoRaw = !html.includes('<script>');
  const hasAllTags =
    html.includes('og:title') &&
    html.includes('og:description') &&
    html.includes('og:image') &&
    html.includes('og:url') &&
    html.includes('twitter:card') &&
    html.includes('twitter:title') &&
    html.includes('twitter:description') &&
    html.includes('twitter:image') &&
    html.includes('name="description"');
  check('C10', hasEscaped && hasNoRaw && hasAllTags, html);
}

// C11: public with empty-after-trim description ('  ') behaves like C4 (generic subtext).
{
  const actual = groupShareCopy(src({ name: 'Foo', description: '   ', isPublic: true }));
  check('C11', actual.subtext === GROUP_SHARE_GENERIC.subtext, actual);
}

// C12: private group, archived, with a description -> still the full generic copy.
{
  const actual = groupShareCopy(src({ name: 'Foo', description: 'Bar', isPublic: false, archived: true }));
  check(
    'C12',
    actual.heading === GROUP_SHARE_GENERIC.heading && actual.subtext === GROUP_SHARE_GENERIC.subtext,
    actual,
  );
}

if (failedIds.length > 0) {
  console.log(`FAIL ${failedIds.length}/${TOTAL_CASES} cases failed: ${failedIds.join(', ')}`);
  process.exit(1);
}

console.log(`SHARE_PREVIEW_OK ${passCount}/${TOTAL_CASES}`);
