// When an invoice line locks itself — the rule, kept out of the table.
//
// A locked line is one Regenerate leaves exactly as it is (`lib/regenerate.ts`,
// "Locked lines"). It exists because Regenerate refreshes hours, dates and
// bullets from the time entries: without it, an owner who trimmed a line from
// 8.75h to 7h and deleted two bullets would press Regenerate and watch both
// edits come straight back.
//
// So a hand edit to one of the fields Regenerate would overwrite locks the line
// in the same update — the owner never has to remember to protect their own
// work. Only those fields count:
//
//   locks          hours, date_from, date_to, sub_items (edit, add, remove,
//                  reorder within a line, or move a bullet between lines)
//   does not lock  rate, description — Regenerate already preserves them, so
//                  locking on them would freeze a line's hours for no reason
//                  the owner could see. Reordering whole lines, and the bulk
//                  Round hours action, do not lock either: neither is a
//                  statement about what one line bills.
//
// And only on lines Regenerate could overwrite at all: a line with a task or a
// tracker behind it. A manual line has no source to refresh from, so locking it
// automatically would change nothing but the badge. The owner can still lock
// one by hand.
//
// Locking is NEVER an editing lock. Nothing here makes a field read-only; it
// only tells Regenerate to leave the row alone (CLAUDE.md § no locking).
//
// Pure functions; no React, no mutation of the inputs.

import type { InvoiceLine } from '../types';
import { lineSourceKey } from './regenerate';

/** Fields whose hand edit locks the line. See the header. */
const AUTO_LOCK_FIELDS = ['hours', 'date_from', 'date_to', 'sub_items'] as const;

/**
 * Whether Regenerate treats this line as locked.
 *
 * `=== true` rather than truthiness: an invoice saved before the flag existed,
 * or served by an older backend, has no `locked` at all, and that means
 * unlocked.
 */
export function isLineLocked(line: Pick<InvoiceLine, 'locked'>): boolean {
  return line.locked === true;
}

/**
 * Whether Regenerate could overwrite this line — it has a task or tracker
 * behind it. Asked of `lineSourceKey`, the merge's own notion of "has a
 * source", so the two can never disagree about which lines those are.
 */
export function canRegenerateOverwrite(line: InvoiceLine): boolean {
  return lineSourceKey(line) !== null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/**
 * Apply `changes` to `line`, locking it when the changes edit hours, a date or
 * the bullets of a line Regenerate could overwrite.
 *
 * A field only counts when its value actually moves, so re-setting the same
 * date is not an edit. An explicit `locked` in `changes` — the row's toggle —
 * always wins, so unlocking is never immediately undone by the rule.
 */
export function withAutoLock(line: InvoiceLine, changes: Partial<InvoiceLine>): InvoiceLine {
  const next: InvoiceLine = { ...line, ...changes };
  if ('locked' in changes) return next;
  if (isLineLocked(line) || !canRegenerateOverwrite(line)) return next;
  const edited = AUTO_LOCK_FIELDS.some(
    (field) => field in changes && !sameValue(line[field], changes[field]),
  );
  return edited ? { ...next, locked: true } : next;
}

/**
 * Lock the lines with these ids — for edits made outside `withAutoLock`, such
 * as a bullet dragged from one line to another by `lib/reorder`, where both the
 * line it left and the line it joined have had their bullets edited.
 *
 * Manual lines are skipped, as in `withAutoLock`. Returns `lines` by identity
 * when nothing needed locking, so a caller's no-op check still holds.
 */
export function lockLines(lines: InvoiceLine[], ids: Iterable<string>): InvoiceLine[] {
  const wanted = new Set(ids);
  let changed = false;
  const next = lines.map((line) => {
    if (!wanted.has(line.line_id) || isLineLocked(line) || !canRegenerateOverwrite(line)) {
      return line;
    }
    changed = true;
    return { ...line, locked: true };
  });
  return changed ? next : lines;
}
