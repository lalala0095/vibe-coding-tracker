// Bare `YYYY-MM-DD` arithmetic, for the three date fields the create sheet
// sends: `period_start`, `period_end` and `issue_date` / `due_date`.
//
// ── Why none of this goes near `.toISOString()` ───────────────────────────────
//
// `period_start` and `period_end` are date-only strings with no instant behind
// them. The tempting one-liner — `new Date().toISOString().slice(0, 10)` — reads
// the *UTC* day. At 21:00 in Singapore that is still yesterday in UTC, so a
// period picked on the evening of the 31st would be sent as ending on the 30th
// and the last day's time entries would silently miss the invoice. See the
// header of `src/lib/sgt.ts`; `todaySgt()` / `sgtDay()` are the sanctioned way
// to get a Singapore calendar day and this file uses nothing else.
//
// `addDays` below does touch `Date`, but only through the UTC constructor and
// the UTC getters, and it formats the result by hand. That is pure calendar
// arithmetic on three numbers — no instant, no timezone, and the phone's own
// zone cannot reach it.

import { parseSgt, sgtDay, todaySgt } from '@/lib/sgt';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** The 1st of the current Singapore month — the usual start of a billing period. */
export function startOfMonthSgt(): string {
  return `${todaySgt().slice(0, 7)}-01`;
}

/**
 * `day` shifted by `days` calendar days, still as `YYYY-MM-DD`.
 *
 * Used for the due date: issue date + the settings' `default_due_days`.
 * Returns the input untouched if it is not a parseable day, so a half-typed
 * value degrades to itself rather than to `NaN-NaN-NaN`.
 */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;

  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);

  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * The Singapore calendar day of whatever `DateTimeField` is holding.
 *
 * The field speaks the full wire format (`2026-08-14T00:00:00+08:00`) while the
 * API wants a bare day, so this is the one conversion between them. It accepts
 * a bare `YYYY-MM-DD` too — `parseSgt` reads one as Singapore midnight — which
 * is what lets the initial values be plain days.
 *
 * Empty string when there is nothing parseable, so the caller can tell "not
 * set" from a real date rather than sending a broken one.
 */
export function dayOf(wire: string | null): string {
  const at = parseSgt(wire);
  return at ? sgtDay(at) : '';
}
