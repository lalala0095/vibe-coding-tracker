// ─────────────────────────────────────────────────────────────────────────────
// COPY of front/src/lib/regenerate.ts. Everything below is byte-identical:
//
//   diff <(tail -n +11 src/lib/regenerate.ts) ../front/src/lib/regenerate.ts
//
// Copied, not ported. This module decides which of an invoice's fields are
// facts about the work (refreshed) and which are authored by the owner
// (preserved). A second hand-written version of that split is how the phone
// starts quietly discarding a rate the web would have kept.
// ─────────────────────────────────────────────────────────────────────────────
// Regenerating an existing invoice's lines — the merge, and nothing else.
//
// "Regenerate" means: re-run the preview against the *current* time entries and
// trackers, then fold that fresh result into the lines already on the invoice.
// The fresh result knows what work exists; the stored lines carry what the user
// wrote. Neither may overwrite the other wholesale, so this module splits every
// field into one camp or the other and merges field by field:
//
//   refreshed  hours, session_ids, date_from, date_to   — facts about the work
//   preserved  rate, description, sub_items, task_title,
//              project_name, line_id                    — authored content
//
// Lines are paired by *source key*, not by position or line_id: a stored line
// and a fresh line describe the same work when they came from the same tracker,
// or from the same (task, project) pair. Position is meaningless because the
// preview re-sorts, and line_id is meaningless because the preview mints a new
// one on every run.
//
// No money arithmetic is *implemented* here — deliberately. `amount` is
// recomputed by the server on every write (CLAUDE.md § Money rules), so
// carrying the stored value through untouched is correct, and writing a second
// copy of those sums here would only invite the two to diverge. Calling into
// `money.ts` is the opposite of that: `roundHoursToIncrement` is imported so
// the increment rounding a regenerate applies is bit-for-bit the one the manual
// Round hours action applies, rather than an approximation of it.
//
// Pure functions; no React, no network, no mutation of the inputs.

import type { HoursRoundingDirection, InvoiceLine, InvoicePreviewLine } from '../types';
import { roundHoursToIncrement } from './money';

export type LineChangeKind = 'added' | 'updated' | 'unchanged' | 'removed' | 'manual';

export interface LineChange {
  kind: LineChangeKind;
  title: string;              // description || task_title, for display
  line: InvoiceLine;          // resulting line; for 'removed', the one going away
  hoursBefore: number | null; // null for 'added'
  hoursAfter: number | null;  // null for 'removed'
  datesChanged: boolean;
  isTracker: boolean;
}

/** The billing increment a regenerate should snap refreshed hours onto. */
export interface RegenerateRounding {
  increment: number;
  direction: HoursRoundingDirection;
}

export interface MergeResult {
  lines: InvoiceLine[];       // apply this to replace the invoice's lines
  changes: LineChange[];      // every line, in result order, removals last
  counts: Record<LineChangeKind, number>;
  hoursBefore: number;        // total across the stored lines
  hoursAfter: number;         // total across the merged lines
  hasChanges: boolean;        // false when applying would be a no-op
}

// Hours have been through 2 dp quantisation server-side and back out through
// JSON, so 9.5 may arrive as 9.499999999999998. Anything below half a hundredth
// of an hour cannot be a real difference, only float noise.
const HOURS_EPSILON = 1e-6;

function hoursEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < HOURS_EPSILON;
}

// Invoices written before `sub_items` / `session_ids` existed have neither, and
// the wire types promise arrays the documents do not actually contain.
function asArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Put a refreshed hours figure through the configured billing increment.
 *
 * Off by default: with no rounding, or an increment that is absent, zero,
 * negative or not a number, the value passes through byte-identical to the
 * preview's. That guard also keeps `roundHoursToIncrement` off its own
 * increment-disabled path, which would quietly re-quantise to 2 dp instead of
 * leaving the number alone.
 */
function applyRounding(hours: number, rounding?: RegenerateRounding | null): number {
  if (!rounding) return hours;
  if (!Number.isFinite(rounding.increment) || rounding.increment <= 0) return hours;
  return roundHoursToIncrement(hours, rounding.increment, rounding.direction);
}

/**
 * The identity of the work a line bills, or null when the line is manual.
 *
 * The task key carries project_id because the server groups time entries by
 * `(task_id, project_id)`: one task worked under two projects is two preview
 * lines, and must stay two invoice lines rather than collapsing into one.
 *
 * Derived from the ids alone, never from `source`, so the same function keys a
 * stored `InvoiceLine` (which has no `source`) and a fresh preview line alike.
 */
export function lineSourceKey(line: InvoiceLine): string | null {
  if (!isBlank(line.tracker_id)) return `tracker:${line.tracker_id}`;
  if (!isBlank(line.task_id)) return `task:${line.task_id}|${line.project_id ?? ''}`;
  return null;
}

/** What the user should see this line called. */
function lineTitle(line: InvoiceLine): string {
  return line.description || line.task_title;
}

// Drop the preview-only fields (`source`, `claimed_by`, `include_by_default`, …)
// before an added line joins the invoice. They are build-time facts about the
// preview, not part of a stored invoice, and shipping them back to the server
// would persist state that is meaningless the moment it is written.
function toStoredLine(line: InvoicePreviewLine, rounding?: RegenerateRounding | null): InvoiceLine {
  return {
    line_id: line.line_id,
    task_id: line.task_id,
    task_title: line.task_title,
    project_id: line.project_id,
    project_name: line.project_name,
    description: line.description,
    date_from: line.date_from,
    date_to: line.date_to,
    hours: applyRounding(line.hours, rounding),
    rate: line.rate,
    amount: line.amount,
    session_ids: asArray(line.session_ids),
    tracker_id: line.tracker_id,
    sub_items: asArray(line.sub_items),
  };
}

function totalHours(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + (Number.isFinite(line.hours) ? line.hours : 0), 0);
}

/**
 * Merge a fresh preview into an invoice's existing lines.
 *
 * Ordering is stable by construction: stored lines are emitted in their current
 * relative order and added lines are appended, so a regenerate never reshuffles
 * an invoice the user has arranged. `changes` follows the same order, with
 * removals collected at the end since they have no place in the result.
 *
 * `rounding` snaps every refreshed figure — on updated and added lines alike —
 * onto the billing increment, and the change classification is made against
 * that rounded value. Without it a line the user had already rounded to 9.50
 * would be reported as changed and reverted to the raw 9.47 the preview
 * carries, undoing their work; with it, a second regenerate is a true no-op.
 * Manual lines are never refreshed, so they are never rounded either.
 *
 * Total: empty inputs yield an empty, coherent result with `hasChanges` false.
 */
export function mergeRegeneratedLines(
  current: InvoiceLine[],
  fresh: InvoicePreviewLine[],
  rounding?: RegenerateRounding | null,
): MergeResult {
  // Fresh lines bucketed by key, in arrival order. A bucket rather than a bare
  // value because a malformed preview could repeat a key; each stored line then
  // consumes at most one fresh line and the surplus falls through as 'added',
  // instead of two stored lines silently sharing one refresh.
  const freshByKey = new Map<string, number[]>();
  fresh.forEach((line, index) => {
    const key = lineSourceKey(line);
    if (key === null) return; // a keyless preview line can only ever be 'added'
    const bucket = freshByKey.get(key);
    if (bucket) bucket.push(index);
    else freshByKey.set(key, [index]);
  });

  const consumed = new Set<number>();
  const lines: InvoiceLine[] = [];
  const changes: LineChange[] = [];
  const removals: LineChange[] = [];

  for (const stored of current) {
    const key = lineSourceKey(stored);

    // Manual lines are authored from nothing, so no fresh line can speak for
    // them. They are kept verbatim and are never candidates for removal.
    if (key === null) {
      lines.push(stored);
      changes.push({
        kind: 'manual',
        title: lineTitle(stored),
        line: stored,
        hoursBefore: stored.hours,
        hoursAfter: stored.hours,
        datesChanged: false,
        isTracker: false,
      });
      continue;
    }

    const bucket = freshByKey.get(key);
    const matchIndex = bucket?.shift();

    if (matchIndex === undefined) {
      // The work this line billed no longer turns up in the period — the entry
      // was deleted, re-dated, or reassigned. Report it; leave it out.
      removals.push({
        kind: 'removed',
        title: lineTitle(stored),
        line: stored,
        hoursBefore: stored.hours,
        hoursAfter: null,
        datesChanged: false,
        isTracker: !isBlank(stored.tracker_id),
      });
      continue;
    }

    consumed.add(matchIndex);
    const match = fresh[matchIndex];

    const datesChanged =
      (stored.date_from ?? null) !== (match.date_from ?? null) ||
      (stored.date_to ?? null) !== (match.date_to ?? null);
    // Compared against the *rounded* figure, because that is what applying
    // would write. A stored 9.50 against a fresh 9.47 that rounds back to 9.50
    // is genuinely unchanged, not an edit worth reporting.
    const freshHours = applyRounding(match.hours, rounding);
    const hoursChanged = !hoursEqual(stored.hours, freshHours);

    // Only the four refreshed fields move; everything else, including `amount`,
    // is the stored line's. A new object either way — the stored one is input
    // and must not be touched.
    const merged: InvoiceLine = {
      ...stored,
      hours: freshHours,
      session_ids: asArray(match.session_ids),
      date_from: match.date_from,
      date_to: match.date_to,
      sub_items: asArray(stored.sub_items),
    };

    lines.push(merged);
    changes.push({
      kind: hoursChanged || datesChanged ? 'updated' : 'unchanged',
      title: lineTitle(merged),
      line: merged,
      hoursBefore: stored.hours,
      hoursAfter: merged.hours,
      datesChanged,
      isTracker: !isBlank(merged.tracker_id),
    });
  }

  fresh.forEach((line, index) => {
    if (consumed.has(index)) return;
    const added = toStoredLine(line, rounding);
    lines.push(added);
    changes.push({
      kind: 'added',
      title: lineTitle(added),
      line: added,
      hoursBefore: null,
      hoursAfter: added.hours,
      datesChanged: false,
      isTracker: !isBlank(added.tracker_id),
    });
  });

  changes.push(...removals);

  const counts: Record<LineChangeKind, number> = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    manual: 0,
  };
  for (const change of changes) counts[change.kind] += 1;

  // A no-op regenerate is one where nothing was gained, nothing lost, and every
  // surviving line still bills the same hours over the same dates. Hour totals
  // are not consulted: two lines could shift hours between them and still sum
  // to the same figure, and that is a real change.
  const hasChanges = counts.added > 0 || counts.removed > 0 || counts.updated > 0;

  return {
    lines,
    changes,
    counts,
    hoursBefore: totalHours(current),
    hoursAfter: totalHours(lines),
    hasChanges,
  };
}
