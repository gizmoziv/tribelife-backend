// verify-shabbat-rollover.mjs
//
// OFFLINE ONLY — never imported by app code. Exercises the pure week-selection
// helpers in src/services/tribe/hebcal.ts against REAL Hebcal /shabbat responses
// captured on 2026-10-03 (embedded below), with a fake fetcher keyed by query
// date. No network, no Redis, no database: hebcal.ts has zero imports.
//
// What it proves:
//   - Saturday (before Havdalah) keeps this week's Shabbat (daysUntil -1) in
//     every timezone, including west of UTC after UTC midnight.
//   - Once Havdalah has passed (an absolute instant, so it is the location's
//     own clock) the server rolls over to next week's Shabbat, exactly once.
//
// Usage (from tribelife-backend/): node --no-warnings scripts/verify-shabbat-rollover.mjs
//   Optional arg: [path/to/hebcal.ts], resolved against the current working
//   directory. Default is relative to this script (tribelife-backend/scripts/).
//   Requires Node v22.18+ (built-in TypeScript type stripping).
//
// Planner-authored gate for quick task 261003-kum. The committed copy in
// tribelife-backend/scripts/ must stay byte-identical to the planning copy.
// Prints SHABBAT_ROLLOVER_OK on success, SHABBAT_ROLLOVER_FAIL <case...> otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../src/services/tribe/hebcal.ts');
const src = fs.readFileSync(modPath, 'utf8');
const m = await import(pathToFileURL(modPath).href);
const { parseHebcalShabbat: P, computeDaysUntil: D, shabbatQueryDate: Q, havdalahHasPassed: H, nextWeekQueryDate: N, resolveShabbatWeek: R } = m;
const fails = [];
const ok = (c, n) => { if (!c) fails.push(n); };
const ymd = (d) => d.toISOString().slice(0, 10);

ok(!/^\s*import\s/m.test(src) && !/require\(/.test(src), 'pure');
ok([P, D, Q, H, N, R].every((f) => typeof f === 'function'), 'exports');
if (fails.length) { console.log('SHABBAT_ROLLOVER_FAIL ' + fails.join(' ')); process.exit(1); }

// Real Hebcal /shabbat responses keyed by the gy/gm/gd query date:
// [location.title, [[category, date, title], ...]] (holiday items kept, others trimmed).
const RAW = {
  nyc: {
    '2026-10-03': ['New York City, New York, USA', [['holiday','2026-10-02','Sukkot VII (Hoshana Raba)'],['candles','2026-10-02T18:18:00-04:00','Candle lighting: 6:18pm'],['holiday','2026-10-03','Shmini Atzeret'],['candles','2026-10-03T19:15:00-04:00','Candle lighting: 7:15pm'],['holiday','2026-10-04','Simchat Torah'],['havdalah','2026-10-04T19:13:00-04:00','Havdalah: 7:13pm']]],
    '2026-10-04': ['New York City, New York, USA', [['holiday','2026-10-04','Simchat Torah'],['havdalah','2026-10-04T19:13:00-04:00','Havdalah: 7:13pm'],['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-05': ['New York City, New York, USA', [['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-07': ['New York City, New York, USA', [['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-08': ['New York City, New York, USA', [['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-09': ['New York City, New York, USA', [['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-10': ['New York City, New York, USA', [['candles','2026-10-09T18:06:00-04:00','Candle lighting: 6:06pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:04:00-04:00','Havdalah: 7:04pm']]],
    '2026-10-11': ['New York City, New York, USA', [['candles','2026-10-16T17:56:00-04:00','Candle lighting: 5:56pm'],['parashat','2026-10-17','Parashat Noach'],['havdalah','2026-10-17T18:53:00-04:00','Havdalah: 6:53pm']]],
  },
  la: {
    '2026-10-10': ['Los Angeles, California, USA', [['candles','2026-10-09T18:08:00-07:00','Candle lighting: 6:08pm'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T19:02:00-07:00','Havdalah: 7:02pm']]],
    '2026-10-11': ['Los Angeles, California, USA', [['candles','2026-10-16T17:59:00-07:00','Candle lighting: 5:59pm'],['parashat','2026-10-17','Parashat Noach'],['havdalah','2026-10-17T18:54:00-07:00','Havdalah: 6:54pm']]],
  },
  jlm: {
    '2026-10-09': ['Jerusalem, Israel', [['candles','2026-10-09T17:34:00+03:00','Candle lighting: 17:34'],['parashat','2026-10-10','Parashat Bereshit'],['havdalah','2026-10-10T18:49:00+03:00','Havdalah: 18:49']]],
    '2026-10-11': ['Jerusalem, Israel', [['candles','2026-10-16T17:26:00+03:00','Candle lighting: 17:26'],['parashat','2026-10-17','Parashat Noach'],['havdalah','2026-10-17T18:41:00+03:00','Havdalah: 18:41']]],
  },
};
const json = (city, day) => {
  const e = RAW[city] && RAW[city][day];
  return e ? { location: { title: e[0] }, items: e[1].map(([category, date, title]) => ({ category, date, title })) } : null;
};

const run = async (city, nowIso, opts = {}) => {
  const now = new Date(nowIso);
  const calls = [];
  const fetchWeek = async (queryDate) => {
    const k = ymd(queryDate);
    calls.push(k);
    if (opts.nullOn === k) return null;
    const j = opts.raw ? opts.raw : json(city, k);
    return j ? P(j, queryDate) : null;
  };
  const info = await R(fetchWeek, now);
  return { info, calls, days: info ? D(info.candleLighting, now) : null };
};

// [case, city, now, expected query dates, expected candle ISO, expected daysUntil]
const CASES = [
  ['nyc:thu', 'nyc', '2026-10-08T12:00:00-04:00', ['2026-10-07'], '2026-10-09T18:06:00-04:00', 1],
  ['nyc:fri', 'nyc', '2026-10-09T10:00:00-04:00', ['2026-10-08'], '2026-10-09T18:06:00-04:00', 0],
  ['nyc:sat', 'nyc', '2026-10-10T12:00:00-04:00', ['2026-10-09'], '2026-10-09T18:06:00-04:00', -1],
  ['nyc:sat-before-havdalah', 'nyc', '2026-10-10T18:30:00-04:00', ['2026-10-09'], '2026-10-09T18:06:00-04:00', -1],
  ['nyc:sat-after-havdalah', 'nyc', '2026-10-10T20:30:00-04:00', ['2026-10-10', '2026-10-11'], '2026-10-16T17:56:00-04:00', 6],
  ['nyc:sun', 'nyc', '2026-10-11T10:00:00-04:00', ['2026-10-10', '2026-10-11'], '2026-10-16T17:56:00-04:00', 5],
  ['la:sat-past-utc-midnight', 'la', '2026-10-10T17:30:00-07:00', ['2026-10-10'], '2026-10-09T18:08:00-07:00', -1],
  ['la:sat-after-havdalah', 'la', '2026-10-10T19:30:00-07:00', ['2026-10-10', '2026-10-11'], '2026-10-16T17:59:00-07:00', 6],
  ['jlm:sat', 'jlm', '2026-10-10T12:00:00+03:00', ['2026-10-09'], '2026-10-09T17:34:00+03:00', -1],
  ['jlm:sat-after-havdalah', 'jlm', '2026-10-10T21:00:00+03:00', ['2026-10-09', '2026-10-11'], '2026-10-16T17:26:00+03:00', 6],
  ['jlm:sun-early', 'jlm', '2026-10-11T01:00:00+03:00', ['2026-10-09', '2026-10-11'], '2026-10-16T17:26:00+03:00', 5],
  ['nyc:yomtov-sun-day', 'nyc', '2026-10-04T12:00:00-04:00', ['2026-10-03'], '2026-10-02T18:18:00-04:00', -2],
  ['nyc:yomtov-sun-night', 'nyc', '2026-10-04T20:00:00-04:00', ['2026-10-04', '2026-10-05'], '2026-10-09T18:06:00-04:00', 5],
];
for (const [name, city, nowIso, calls, candle, days] of CASES) {
  const r = await run(city, nowIso);
  ok(JSON.stringify(r.calls) === JSON.stringify(calls), name + ':calls');
  ok(!!r.info && r.info.candleLighting === candle, name + ':candle');
  ok(r.days === days, name + ':days');
}

// Rolled-over week carries next week's havdalah and parsha.
const ro = await run('nyc', '2026-10-10T20:30:00-04:00');
ok(!!ro.info && ro.info.havdalah === '2026-10-17T18:53:00-04:00' && ro.info.parsha === 'Noach', 'rollover:fields');
// Yom Tov Sunday night: rollover also replaces the earlier Yom Tov havdalah.
const yt = await run('nyc', '2026-10-04T20:00:00-04:00');
ok(!!yt.info && yt.info.havdalah === '2026-10-10T19:04:00-04:00', 'yomtov:havdalah');

// Upstream failure on the rollover fetch keeps the current week (never empty).
const nf = await run('nyc', '2026-10-10T20:30:00-04:00', { nullOn: '2026-10-11' });
ok(!!nf.info && nf.info.candleLighting === '2026-10-09T18:06:00-04:00' && JSON.stringify(nf.calls) === '["2026-10-10","2026-10-11"]', 'rollover:nullnext');
const ff = await run('nyc', '2026-10-10T12:00:00-04:00', { nullOn: '2026-10-09' });
ok(ff.info === null && ff.calls.length === 1, 'firstnull');

// No havdalah item: never rolls over.
const noH = { location: { title: 'X' }, items: [{ category: 'candles', date: '2026-10-09T18:06:00-04:00', title: 'Candle lighting' }] };
const nh = await run('nyc', '2026-10-11T23:00:00-04:00', { raw: noH });
ok(nh.calls.length === 1 && !!nh.info && nh.info.havdalah === null, 'nohavdalah');

// Pure helpers.
ok(ymd(Q(new Date('2026-10-11T00:30:00Z'))) === '2026-10-10' && ymd(Q(new Date('2026-10-10T16:00:00Z'))) === '2026-10-09', 'querydate');
const hv = { candleLighting: null, havdalah: '2026-10-10T19:04:00-04:00', parsha: null, parshaHebrew: null, locationLabel: null, shabbatDate: null, daysUntil: null };
ok(H(hv, new Date('2026-10-10T23:04:00Z')) === true && H(hv, new Date('2026-10-10T23:03:59Z')) === false, 'passed:boundary');
ok(H({ ...hv, havdalah: null }, new Date('2030-01-01T00:00:00Z')) === false && H({ ...hv, havdalah: 'garbage' }, new Date('2030-01-01T00:00:00Z')) === false, 'passed:null');
const nx = N(hv);
ok(!!nx && ymd(nx) === '2026-10-11' && N({ ...hv, havdalah: null }) === null && N({ ...hv, havdalah: '2026-12-31T16:30:00+02:00' }) !== null && ymd(N({ ...hv, havdalah: '2026-12-31T16:30:00+02:00' })) === '2027-01-01', 'nextweek');

// Parser sanity on real data (unchanged behaviour).
const p = P(json('nyc', '2026-10-10'), new Date('2026-10-10T16:00:00Z'));
ok(p.parsha === 'Bereshit' && !!p.parshaHebrew && p.shabbatDate === '2026-10-10' && p.locationLabel === 'New York City, New York, USA', 'parser');

console.log(fails.length ? 'SHABBAT_ROLLOVER_FAIL ' + fails.slice(0, 12).join(' ') : 'SHABBAT_ROLLOVER_OK');
