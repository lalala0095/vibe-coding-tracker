// Unit checks for mobile/src/lib/sgt.ts and mobile/src/lib/hours.ts.
// Run: node --experimental-strip-types sgt.test.mts
//
// Deliberately run under a NON-Singapore TZ as well (see run-sgt-tests.sh):
// every one of these must pass identically whatever the device timezone is,
// which is the entire point of the module.

import {
  formatElapsed,
  formatSgtDate,
  formatSgtDateTime,
  formatSgtTime,
  fromSgtFields,
  nowSgt,
  parseSgt,
  sgtDay,
  sgtDayKey,
  sgtFields,
  toSgtIso,
  todaySgt,
} from './sgt.ts';

import { formatHours, formatHoursLabel, sumHours } from './hours.ts';

let passed = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
}

// ── toSgtIso: the wire format ────────────────────────────────────────────────
// 2026-08-14T13:05:33Z is 21:05:33 in Singapore.
const afternoon = new Date(Date.UTC(2026, 7, 14, 13, 5, 33));
eq('toSgtIso midday', toSgtIso(afternoon), '2026-08-14T21:05:33+08:00');
eq('sgtDay midday', sgtDay(afternoon), '2026-08-14');

// ── THE regression: the midnight-to-08:00 window ─────────────────────────────
// 16:30Z is 00:30 the NEXT day in Singapore. This is the exact case that
// front/src/pages/TrackersPage.tsx:1264 gets wrong with toISOString().
const justAfterMidnightSgt = new Date(Date.UTC(2026, 7, 14, 16, 30, 0));
eq('sgtDay after SGT midnight', sgtDay(justAfterMidnightSgt), '2026-08-15');
eq(
  'toSgtIso after SGT midnight',
  toSgtIso(justAfterMidnightSgt),
  '2026-08-15T00:30:00+08:00'
);
// ...and proof that the naive approach really does disagree, so this test is
// testing something real rather than restating the implementation.
eq(
  'toISOString would have been wrong',
  justAfterMidnightSgt.toISOString().slice(0, 10),
  '2026-08-14'
);

// One second before SGT midnight — must still be the 14th.
const lastSecond = new Date(Date.UTC(2026, 7, 14, 15, 59, 59));
eq('sgtDay one second before midnight', sgtDay(lastSecond), '2026-08-14');
eq('toSgtIso one second before midnight', toSgtIso(lastSecond), '2026-08-14T23:59:59+08:00');

// Exactly SGT midnight.
const midnight = new Date(Date.UTC(2026, 7, 14, 16, 0, 0));
eq('sgtDay exactly midnight', sgtDay(midnight), '2026-08-15');
eq('toSgtIso exactly midnight', toSgtIso(midnight), '2026-08-15T00:00:00+08:00');

// Year boundary — 31 Dec 16:00Z is 1 Jan in Singapore.
const newYear = new Date(Date.UTC(2026, 11, 31, 16, 0, 0));
eq('sgtDay across the year boundary', sgtDay(newYear), '2027-01-01');
eq('toSgtIso across the year boundary', toSgtIso(newYear), '2027-01-01T00:00:00+08:00');

// ── sgtFields ────────────────────────────────────────────────────────────────
eq('sgtFields', sgtFields(afternoon), {
  year: 2026, month: 8, day: 14, hour: 21, minute: 5, second: 33,
});
eq('sgtFields month is 1-based', sgtFields(new Date(Date.UTC(2026, 0, 1, 4, 0, 0))).month, 1);

// ── parseSgt ─────────────────────────────────────────────────────────────────
const instant = Date.UTC(2026, 7, 14, 13, 5, 33);
eq('parseSgt with +08:00', parseSgt('2026-08-14T21:05:33+08:00')?.getTime(), instant);
eq('parseSgt with Z', parseSgt('2026-08-14T13:05:33Z')?.getTime(), instant);
eq('parseSgt with +0800 (no colon)', parseSgt('2026-08-14T21:05:33+0800')?.getTime(), instant);
// No offset at all must be read as Singapore, NOT as the device's local time.
eq('parseSgt bare is treated as SGT', parseSgt('2026-08-14T21:05:33')?.getTime(), instant);
eq('parseSgt bare === explicit +08:00',
   parseSgt('2026-08-14T21:05:33')?.getTime(),
   parseSgt('2026-08-14T21:05:33+08:00')?.getTime());
eq('parseSgt null', parseSgt(null), null);
eq('parseSgt undefined', parseSgt(undefined), null);
eq('parseSgt empty', parseSgt(''), null);
eq('parseSgt garbage', parseSgt('not a date'), null);

// A bare YYYY-MM-DD means Singapore midnight. It is a real shape here —
// due_date, period_start/end, date_from/date_to are all date-only — and before
// this branch existed it produced "2026-08-14+08:00" and parsed to null,
// silently blanking every day heading formatted from a group key.
eq('parseSgt bare date is SGT midnight',
   parseSgt('2026-08-14')?.getTime(), Date.UTC(2026, 7, 13, 16, 0, 0));
eq('parseSgt bare date === explicit midnight',
   parseSgt('2026-08-14')?.getTime(), parseSgt('2026-08-14T00:00:00+08:00')?.getTime());
eq('bare date formats rather than blanking', formatSgtDate('2026-08-14'), 'Fri, 14 Aug 2026');
eq('bare date round trips to its own day', sgtDay(parseSgt('2026-08-14')!), '2026-08-14');
eq('sgtDayKey of a bare date is itself', sgtDayKey('2026-08-14'), '2026-08-14');
eq('parseSgt rejects a bad bare date', parseSgt('2026-13-45'), null);
eq('parseSgt whitespace-padded', parseSgt('  2026-08-14T21:05:33+08:00  ')?.getTime(), instant);

// ── Round trip ───────────────────────────────────────────────────────────────
const wire = '2026-08-15T00:30:00+08:00';
eq('round trip', toSgtIso(parseSgt(wire)!), wire);

// ── fromSgtFields: what a picker emits ───────────────────────────────────────
eq('fromSgtFields full',
   fromSgtFields({ year: 2026, month: 8, day: 14, hour: 9, minute: 30 }),
   '2026-08-14T09:30:00+08:00');
eq('fromSgtFields pads',
   fromSgtFields({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 }),
   '2026-01-02T03:04:05+08:00');
eq('fromSgtFields defaults time to midnight',
   fromSgtFields({ year: 2026, month: 8, day: 14 }),
   '2026-08-14T00:00:00+08:00');
// A picker value must survive a round trip through the parser unchanged.
eq('fromSgtFields round trips',
   toSgtIso(parseSgt(fromSgtFields({ year: 2026, month: 8, day: 14, hour: 9, minute: 30 }))!),
   '2026-08-14T09:30:00+08:00');

// ── sgtDayKey ────────────────────────────────────────────────────────────────
eq('sgtDayKey groups by SGT day', sgtDayKey('2026-08-14T23:59:00+08:00'), '2026-08-14');
eq('sgtDayKey after midnight', sgtDayKey('2026-08-15T00:01:00+08:00'), '2026-08-15');
eq('sgtDayKey on a Z timestamp', sgtDayKey('2026-08-14T16:30:00Z'), '2026-08-15');
eq('sgtDayKey null', sgtDayKey(null), null);

// ── Display formatting ───────────────────────────────────────────────────────
// 2026-08-14 is a Friday, 2026-08-15 a Saturday (verified with `date -d`).
eq('formatSgtDate', formatSgtDate('2026-08-14T21:05:33+08:00'), 'Fri, 14 Aug 2026');
eq('formatSgtDate rolls the weekday over midnight',
   formatSgtDate('2026-08-14T16:30:00Z'), 'Sat, 15 Aug 2026');
eq('formatSgtTime', formatSgtTime('2026-08-14T09:05:00+08:00'), '09:05');
eq('formatSgtDateTime', formatSgtDateTime('2026-08-14T21:05:33+08:00'), '14 Aug 2026, 21:05');
eq('formatSgtDate null', formatSgtDate(null), '—');
eq('formatSgtTime garbage', formatSgtTime('nope'), '—');

// ── formatElapsed ────────────────────────────────────────────────────────────
const start = '2026-08-14T09:00:00+08:00';
eq('formatElapsed 2h14m37s',
   formatElapsed(start, parseSgt('2026-08-14T11:14:37+08:00')!), '02:14:37');
eq('formatElapsed zero', formatElapsed(start, parseSgt(start)!), '00:00:00');
eq('formatElapsed pads', formatElapsed(start, parseSgt('2026-08-14T09:00:07+08:00')!), '00:00:07');
eq('formatElapsed past 24h',
   formatElapsed(start, parseSgt('2026-08-15T10:00:00+08:00')!), '25:00:00');
// A start time in the future is something the user is free to enter; it must
// read as zero rather than as a negative clock. Warn, never block.
eq('formatElapsed negative clamps to zero',
   formatElapsed(start, parseSgt('2026-08-14T08:00:00+08:00')!), '00:00:00');
eq('formatElapsed null', formatElapsed(null), '—');

// ── nowSgt / todaySgt shape ──────────────────────────────────────────────────
eq('nowSgt shape', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(nowSgt()), true);
eq('todaySgt shape', /^\d{4}-\d{2}-\d{2}$/.test(todaySgt()), true);
eq('nowSgt agrees with todaySgt', nowSgt().slice(0, 10), todaySgt());
eq('nowSgt is parseable back to now (within 2s)',
   Math.abs(parseSgt(nowSgt())!.getTime() - Date.now()) < 2000, true);

// ── hours.ts — display only ──────────────────────────────────────────────────
eq('sumHours avoids float drift', sumHours([0.1, 0.2]), 0.3);
eq('sumHours 12.1 + 0.2', sumHours([12.1, 0.2]), 12.3);
eq('sumHours a real day', sumHours([1.5, 2.25, 0.75, 3.1]), 7.6);
eq('sumHours empty', sumHours([]), 0);
eq('sumHours skips null/undefined', sumHours([1.5, null, undefined, 0.5]), 2);
eq('sumHours skips NaN', sumHours([1.5, NaN]), 1.5);
// Unclamped, like the over-discount on the server: a total that disagrees with
// the rows above it would hide a real discrepancy.
eq('sumHours keeps a negative', sumHours([-1.5, 0.5]), -1);
eq('formatHours', formatHours(3.25), '3.25');
eq('formatHours pads to 2dp', formatHours(3), '3.00');
eq('formatHours null', formatHours(null), '0.00');
eq('formatHours drift-free', formatHours(sumHours([0.1, 0.2])), '0.30');
eq('formatHoursLabel', formatHoursLabel(7.6), '7.60 h');

// ── Report ───────────────────────────────────────────────────────────────────
const tz = process.env.TZ ?? '(system default)';
if (failures.length) {
  console.log(`\nTZ=${tz}  ✗ ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`TZ=${tz}  ✓ all ${passed} passed`);
