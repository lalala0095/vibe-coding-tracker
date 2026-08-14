// Time helpers the Now screen needs and `src/lib/sgt.ts` does not carry.
//
// Nothing here calls `.toISOString()`, and nothing here formats a timestamp —
// every wire string is produced by `sgt.ts` and every display string is read
// back out of it. These are the two derived numbers the screen needs on top of
// that: a tracker's span in hours, and the wall-clock moment its auto-name
// should be rendered for.

import { parseSgt, sgtFields } from '@/lib/sgt';
import type { Tracker } from '@/types';

/**
 * A tracker's span in hours, to 2 dp.
 *
 * A running tracker measures to `now` rather than returning null: the phone
 * pre-fills the billing hours from it (§6.1), and the server refuses to bill a
 * running tracker without a number. It is a **default, not a constraint** — the
 * field it lands in stays editable.
 *
 * Deliberately not clamped at zero. A start time in the future is something the
 * user is allowed to enter, and a negative span makes that visible instead of
 * quietly reading as 0.
 */
export function elapsedHours(tracker: Tracker, now: Date = new Date()): number | null {
  const start = parseSgt(tracker.start_time);
  if (!start) return null;

  const end = tracker.end_time ? parseSgt(tracker.end_time) : now;
  if (!end) return null;

  return Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100;
}

/** True when a stored timestamp is later than now — worth a warning, never a block. */
export function isFuture(iso: string | null | undefined, now: Date = new Date()): boolean {
  const at = parseSgt(iso);
  return at !== null && at.getTime() > now.getTime();
}

/**
 * The `Date` a tracker's auto-name is rendered for.
 *
 * `lib/trackerName.ts` reads a Date's **local** getters — correct on the web,
 * which only ever runs on a machine set to Singapore time. A phone is not that
 * machine. So the Singapore wall-clock fields are read out with `sgtFields()`
 * and put back into a Date through the *local* constructor, which makes the
 * local getters return the Singapore numbers whatever timezone the phone is
 * set to. Same bridge `DateTimeField` uses for the picker.
 *
 * An unparseable or empty start time falls back to now, matching
 * `nameMoment()` in `front/src/pages/TrackersPage.tsx`.
 */
export function nameMoment(startTimeIso: string | null | undefined): Date {
  const at = parseSgt(startTimeIso);
  if (!at) return new Date();

  const f = sgtFields(at);
  return new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
}

/** The most recently started tracker, or null. Used when several are running. */
export function mostRecentlyStarted(trackers: Tracker[]): Tracker | null {
  let best: Tracker | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;

  for (const tracker of trackers) {
    const at = parseSgt(tracker.start_time)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (best === null || at > bestAt) {
      best = tracker;
      bestAt = at;
    }
  }

  return best;
}
