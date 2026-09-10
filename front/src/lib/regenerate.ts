// Regenerating an existing invoice's lines — the merge, and nothing else.
//
// "Regenerate" means: re-run the preview against the *current* time entries and
// trackers, then fold that fresh result into the lines already on the invoice.
// The fresh result knows what work exists; the stored lines carry what the user
// wrote. Neither may overwrite the other wholesale, so this module splits every
// field into one camp or the other and merges field by field:
//
//   refreshed  hours, session_ids, date_from, date_to,
//              sub_items (tracker lines only),          — facts about the work
//              project_name (only when `projectNames` is supplied)
//   preserved  rate, description, task_title,
//              line_id,
//              sub_items (task lines)                   — authored content
//
// `sub_items` sits in both camps, and the split is not arbitrary — it follows
// who actually knows the answer:
//
//   tracker line  The server rebuilds `sub_items` from the tracker's CURRENT
//                 task list on every preview (`invoices.py:1296`). That makes
//                 it derived data, and keeping the stored copy is what made a
//                 task added to a tracker never appear on a regenerate.
//   task line     The preview never populates `sub_items` for these at all —
//                 the `(task_id, project_id)` grouping reads time entries and
//                 never opens the task document, so `match.sub_items` is
//                 always `[]`. Taking the fresh value here would replace a
//                 hand-written bullet list with nothing.
//
// So a tracker line's bullets refresh and a task line's are left alone. If
// task lines are ever taught to carry their sub-tasks, this is the one line
// that has to change with them.
//
// ── project_name, and why it needs a live lookup rather than the preview ─────
//
// Renaming a project writes ONE document: `projects/{id}`. It does not touch
// the `project_name` denormalised onto every task and time entry
// (`back/routers/projects.py:update_project`). The preview builds its lines
// from exactly those denormalised copies — `session.project_name` for a task
// line, `task.project_name` for a tracker line — so `match.project_name` is
// just as stale as the stored one. Taking the fresh value would change
// nothing.
//
// So the caller passes `projectNames`: id → the name as it stands in the
// Clients & Projects view right now. That is the only source in the system
// that a rename actually updates. When a line's `project_id` is absent from
// the map — a manual line, a deleted project, or a caller that did not supply
// one — the stored name is kept, because "not loaded" and "renamed to empty"
// must not look the same.
//
// This is a deliberate exception to the snapshot rule in CLAUDE.md. Snapshots
// exist so that time passing never rewrites a past invoice; regenerate is not
// time passing, it is the owner explicitly asking to re-read the world. The
// rate stays snapshotted regardless — a rename is a correction to a label, a
// rate change is a change to what the work is worth.
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
  /** The bullet list under the description moved. Tracker lines only. */
  subItemsChanged: boolean;
  /**
   * The project was renamed in Clients & Projects since this line was written.
   * `null` on both when nothing moved, so a caller can render `before → after`
   * without a second comparison.
   */
  projectNameBefore: string | null;
  projectNameAfter: string | null;
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

// Order matters: these are printed as a bullet list, so re-ordering them is a
// visible change to the document even when the same titles are present.
function sameItems(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
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
  /**
   * Live project names by id. Omit to leave every `project_name` untouched,
   * which is exactly what this function did before renames were handled.
   */
  projectNames?: Map<string, string> | null,
): MergeResult {
  /**
   * The name a line should carry, and whether that is a change.
   *
   * Returns the STORED name whenever the map cannot answer — a missing id
   * means "not loaded" or "project deleted", neither of which is licence to
   * blank a name that is printed on an invoice. An empty live name is treated
   * the same way: a project cannot usefully be renamed to nothing, so it reads
   * as an unloaded entry rather than as an instruction to clear the field.
   */
  function nameFor(line: { project_id: string | null; project_name: string }): {
    name: string;
    before: string | null;
    after: string | null;
  } {
    const stored = line.project_name ?? '';
    if (!projectNames || !line.project_id) return { name: stored, before: null, after: null };
    const live = projectNames.get(line.project_id);
    if (live === undefined || isBlank(live) || live === stored) {
      return { name: stored, before: null, after: null };
    }
    return { name: live, before: stored, after: live };
  }

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
      // A manual line is authored from nothing, but it can still carry a
      // project_id, and a rename is a correction to a label rather than a
      // rewrite of authored content. Its hours and text stay untouched.
      const renamedManual = nameFor(stored);
      const manualLine: InvoiceLine =
        renamedManual.after === null ? stored : { ...stored, project_name: renamedManual.name };
      lines.push(manualLine);
      changes.push({
        kind: 'manual',
        title: lineTitle(manualLine),
        line: manualLine,
        hoursBefore: manualLine.hours,
        hoursAfter: manualLine.hours,
        datesChanged: false,
        subItemsChanged: false,
        projectNameBefore: renamedManual.before,
        projectNameAfter: renamedManual.after,
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
        subItemsChanged: false,
        // A line on its way out is reported as it was stored. Renaming a
        // project on something about to be deleted is noise.
        projectNameBefore: null,
        projectNameAfter: null,
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
    // See the header for why this is split by line kind rather than simply
    // refreshed or simply preserved.
    const storedSubItems = asArray(stored.sub_items);
    const subItems = isBlank(stored.tracker_id)
      ? storedSubItems
      : asArray(match.sub_items);
    const subItemsChanged = !sameItems(storedSubItems, subItems);

    // Resolved from the STORED line: `match.project_name` is the same
    // denormalised copy and is stale in exactly the same way. See the header.
    const renamed = nameFor(stored);

    const merged: InvoiceLine = {
      ...stored,
      hours: freshHours,
      session_ids: asArray(match.session_ids),
      date_from: match.date_from,
      date_to: match.date_to,
      sub_items: subItems,
      project_name: renamed.name,
    };

    lines.push(merged);
    changes.push({
      kind:
        hoursChanged || datesChanged || subItemsChanged || renamed.after !== null
          ? 'updated'
          : 'unchanged',
      title: lineTitle(merged),
      line: merged,
      hoursBefore: stored.hours,
      hoursAfter: merged.hours,
      datesChanged,
      subItemsChanged,
      projectNameBefore: renamed.before,
      projectNameAfter: renamed.after,
      isTracker: !isBlank(merged.tracker_id),
    });
  }

  fresh.forEach((line, index) => {
    if (consumed.has(index)) return;
    // An added line arrives with the same denormalised name as everything
    // else, so it needs the same live lookup — otherwise regenerating an
    // invoice would ADD a line already carrying the old project name.
    const addedName = nameFor(line);
    const added = { ...toStoredLine(line, rounding), project_name: addedName.name };
    lines.push(added);
    changes.push({
      kind: 'added',
      title: lineTitle(added),
      line: added,
      hoursBefore: null,
      hoursAfter: added.hours,
      datesChanged: false,
      subItemsChanged: false,
      // The line is new, so its name is not a rename of anything the invoice
      // was showing. Reported as clean.
      projectNameBefore: null,
      projectNameAfter: null,
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
  //
  // The `manual` term is not redundant. A renamed project on a manual line is
  // a real change, but a manual line keeps `kind: 'manual'` rather than
  // becoming 'updated' — that kind says where the line came from, and losing
  // it would tell the reader the line had been rebuilt from time entries when
  // it had not. Without this term an invoice whose ONLY stale name sits on a
  // manual line would report "nothing to apply" and the rename could never be
  // applied at all.
  const renamed = changes.some((change) => change.projectNameAfter !== null);
  const hasChanges =
    counts.added > 0 || counts.removed > 0 || counts.updated > 0 || renamed;

  return {
    lines,
    changes,
    counts,
    hoursBefore: totalHours(current),
    hoursAfter: totalHours(lines),
    hasChanges,
  };
}
