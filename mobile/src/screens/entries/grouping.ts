// Grouping and windowing for the Time Entries screen. Pure functions only —
// nothing here touches the network or React.
//
// ── Why the day key comes from `sgtDayKey` ────────────────────────────────────
//
// A time entry belongs to the Singapore calendar day it started on, because
// that is the day an invoice bills it under. Reading the day with
// `new Date(iso).getDate()` would read the *phone's* day instead: an entry
// started at 00:30 SGT lands under the previous day's heading on a phone in
// London, and the totals under each heading would then disagree with the
// invoice built from the same rows. `sgtDayKey` shifts to Singapore first.
//
// ── Hours are never recomputed ───────────────────────────────────────────────
//
// `effective_hours` arrives resolved and rounded from the server
// (`back/routers/sessions.py`). Totals here only add the numbers up, via
// `sumHours`, which exists solely so a column of 2 dp figures does not sit
// under a float-noise total. See the header of `src/lib/hours.ts`.

import { sumHours } from '@/lib/hours';
import { formatSgtDate, fromSgtFields, parseSgt, sgtDayKey, sgtFields } from '@/lib/sgt';
import type { TimeEntry } from '@/types';

/** Key for entries whose `start_time` will not parse. They sort last. */
export const UNDATED = 'undated';

export interface DayGroup {
  /** `YYYY-MM-DD` in Singapore time, or `UNDATED`. */
  day: string;
  entries: TimeEntry[];
  /** Sum of the group's `effective_hours`, as returned by the server. */
  hours: number;
}

function startedAt(entry: TimeEntry): number {
  // `parseSgt` rather than `new Date(...)`: it reads an offset-less timestamp as
  // Singapore time instead of as the phone's. A malformed one sorts to the very
  // end rather than throwing the whole list into `NaN` comparisons.
  return parseSgt(entry.start_time)?.getTime() ?? Number.NEGATIVE_INFINITY;
}

/** Newest first, split into Singapore calendar days. */
export function groupByDay(entries: TimeEntry[]): DayGroup[] {
  const ordered = [...entries].sort((a, b) => startedAt(b) - startedAt(a));

  const buckets = new Map<string, TimeEntry[]>();
  for (const entry of ordered) {
    const key = sgtDayKey(entry.start_time) ?? UNDATED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNDATED) return 1;
      if (b === UNDATED) return -1;
      return b.localeCompare(a);
    })
    .map(([day, list]) => ({
      day,
      entries: list,
      hours: sumHours(list.map((entry) => entry.effective_hours)),
    }));
}

/** Total across every group, for the header. */
export function totalHours(entries: TimeEntry[]): number {
  return sumHours(entries.map((entry) => entry.effective_hours));
}

/**
 * `Thu, 14 Aug 2026` for a day heading.
 *
 * A bare `YYYY-MM-DD` is not something `parseSgt` accepts — appending `+08:00`
 * to it yields an unparseable string — so the key is expanded to Singapore
 * midnight before formatting.
 */
export function formatDayHeading(day: string): string {
  if (day === UNDATED) return 'Date unknown';
  return formatSgtDate(`${day}T00:00:00+08:00`);
}

/**
 * Invoices claiming an entry. The list is the truth; the scalar is a fallback
 * for documents written before the list existed (`src/types.ts`).
 */
export function claimingInvoices(entry: TimeEntry): string[] {
  if (entry.invoice_numbers?.length) return entry.invoice_numbers;
  return entry.invoice_number ? [entry.invoice_number] : [];
}

// ── The date window ──────────────────────────────────────────────────────────
//
// The two date filters are held as wire timestamps at Singapore midnight, which
// is what `DateTimeField` speaks; `date_from` / `date_to` are derived from them
// with `sgtDayKey`. Nothing here goes near `.toISOString().slice(0, 10)`, which
// would send yesterday's date for the first eight hours of every Singapore day.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the screen looks before the user says otherwise. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Singapore midnight of an instant's calendar day, in the wire format. */
export function sgtMidnight(at: Date): string {
  const f = sgtFields(at);
  return fromSgtFields({ year: f.year, month: f.month, day: f.day });
}

/** The window the screen opens on: the last two weeks, today included. */
export function defaultWindow(): { from: string; to: string } {
  const now = new Date();
  return {
    from: sgtMidnight(new Date(now.getTime() - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS)),
    to: sgtMidnight(now),
  };
}

/** A sentence saying exactly which window is on screen. */
export function describeWindow(from: string | null, to: string | null): string {
  if (from && to) return `${formatSgtDate(from)} – ${formatSgtDate(to)}`;
  if (from) return `${formatSgtDate(from)} onwards`;
  if (to) return `everything up to ${formatSgtDate(to)}`;
  return 'every time entry';
}
