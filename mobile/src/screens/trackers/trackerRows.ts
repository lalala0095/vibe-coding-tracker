// Deriving what a tracker row shows, and nothing else.
//
// Pure functions over `Tracker`, kept out of the components so the list's
// arithmetic can be read — and checked — in one place. Two rules run through
// all of it:
//
//   * No `.toISOString()` anywhere. Every timestamp is read through
//     `src/lib/sgt.ts`, which is also where the reason is written down.
//   * No money. `elapsedHours()` is a wall-clock span and `sumHours()` is a
//     display total; neither is a rate, an amount, or an input to one. The
//     money rules live on the server (`back/services/invoice_service.py`) and
//     on the web (`front/src/lib/money.ts`), and this app deliberately owns no
//     third copy.
//
// `elapsedHours` and `isFuture` are imported from `src/screens/now/trackerTime.ts`
// rather than rewritten: the Now screen already decided what a tracker's span
// means (running measures to now, a negative span is shown rather than clamped)
// and two answers to that question is one too many.

import { sumHours } from '@/lib/hours';
import { formatElapsed, formatSgtDate, formatSgtTime, parseSgt, sgtDay } from '@/lib/sgt';
import { elapsedHours } from '@/screens/now/trackerTime';
import type { Tracker } from '@/types';

/** All, still running, or finished. Mirrors the web's three-way filter. */
export type TrackerFilter = 'all' | 'running' | 'done';

export const TRACKER_FILTERS: ReadonlyArray<readonly [TrackerFilter, string]> = [
  ['all', 'All'],
  ['running', 'Running'],
  ['done', 'Done'],
];

/**
 * A tracker with no end time is still running.
 *
 * This is the whole of the running/stopped distinction in this system — there
 * is no status field. Which is also why *clearing* `end_time` restarts one.
 */
export function isRunning(tracker: Tracker): boolean {
  return !tracker.end_time;
}

/**
 * Newest start first.
 *
 * `GET /trackers` already orders by `start_time` descending, but it does so as
 * a Firestore string sort. That is only the same ordering while every stored
 * value carries the same offset and the same shape, so the parsed instant is
 * sorted on here instead of trusting the lexicographic accident. A tracker
 * whose start time will not parse sorts last rather than disappearing.
 */
export function sortByStartDesc(trackers: Tracker[]): Tracker[] {
  return trackers
    .map((tracker, index) => ({
      tracker,
      index,
      at: parseSgt(tracker.start_time)?.getTime() ?? Number.NEGATIVE_INFINITY,
    }))
    // The index tiebreak keeps equal starts in the order the server sent them,
    // rather than leaving it to the sort's stability.
    .sort((a, b) => (b.at - a.at) || (a.index - b.index))
    .map((entry) => entry.tracker);
}

export function filterTrackers(trackers: Tracker[], filter: TrackerFilter): Tracker[] {
  if (filter === 'running') return trackers.filter(isRunning);
  if (filter === 'done') return trackers.filter((tracker) => !isRunning(tracker));
  return trackers;
}

/**
 * `Thu, 14 Aug 2026 · 09:00 → 12:30`, and `→ now` while it runs.
 *
 * The end date is only repeated when the block crosses midnight, which is the
 * case worth seeing and the only one where the time alone is ambiguous.
 */
export function spanLabel(tracker: Tracker): string {
  const start = parseSgt(tracker.start_time);
  if (!start) return '—';

  const from = `${formatSgtDate(tracker.start_time)} · ${formatSgtTime(tracker.start_time)}`;
  if (!tracker.end_time) return `${from} → now`;

  const end = parseSgt(tracker.end_time);
  if (!end) return `${from} → —`;

  return sgtDay(start) === sgtDay(end)
    ? `${from} → ${formatSgtTime(tracker.end_time)}`
    : `${from} → ${formatSgtDate(tracker.end_time)} · ${formatSgtTime(tracker.end_time)}`;
}

/**
 * `02:14:37` — the clock, ticking while the tracker runs and fixed once it has
 * stopped. `now` is passed in so one interval drives every row on the screen.
 */
export function durationLabel(tracker: Tracker, now: Date): string {
  const until = tracker.end_time ? (parseSgt(tracker.end_time) ?? now) : now;
  return formatElapsed(tracker.start_time, until);
}

/**
 * The list's total, in hours, for display under a filter.
 *
 * Summed through `sumHours` for the reason its own header gives: a plain
 * `reduce` renders `12.299999999999999`. It is a sum of wall-clock spans, not
 * of billable hours — a tracker's time only becomes billable once it is turned
 * into time entries, and the server computes those.
 */
export function totalHours(trackers: Tracker[], now: Date): number {
  return sumHours(trackers.map((tracker) => elapsedHours(tracker, now)));
}

/**
 * True when a tracker ends before it starts.
 *
 * Not an error and never blocked — it is the user's business (CLAUDE.md § no
 * locking). It is said out loud because the clock reads `00:00:00` for it,
 * which otherwise looks like a bug rather than like the data.
 */
export function endsBeforeStart(tracker: Tracker): boolean {
  const start = parseSgt(tracker.start_time);
  const end = parseSgt(tracker.end_time);
  return start !== null && end !== null && end.getTime() < start.getTime();
}

/** `2 tasks`, `1 task`, `No tasks`. */
export function taskCountLabel(tracker: Tracker): string {
  const count = tracker.tasks.length;
  if (count === 0) return 'No tasks';
  return `${count} task${count === 1 ? '' : 's'}`;
}
