// How time entries are cut into invoice lines — shared by the builder and
// Regenerate.
//
// The owner bills as Invoice → Tasks → the time entries logged against each
// task, and writes the detail of the work into each entry's notes. So a task
// line's bullets ARE its entries' note lines, in both layouts.
//
// The preview endpoint groups billable time entries by (task, project): one
// line per task, hours summed across the whole period, and no bullets under it
// — the server never reads notes. The 'task' layout keeps that grouping and
// attaches the notes (`attachNotesToTaskLines`). That suits a long-running
// task and reads badly for a day-by-day log, so the 'daily' layout re-cuts the
// same lines one per task per day, each with that day's notes
// (`expandToDailyLines`) — the per-day detail a tracker line gives, without
// creating a nested task for every item.
//
// ── Trackers the time entries already bill ──────────────────────────────────
//
// A tracker line and the time entries on that tracker's tasks describe the
// same day's work. The server spots that pairing only through an entry's
// `tracker_id`, and an entry logged by hand against the tracker's task has
// none — so the preview offered both and the day was charged twice. When the
// entries are present they win: they carry the hours per task and the notes.
// `markTrackersCoveredByEntries` pairs them by (task, day) instead and leaves
// the tracker line unticked with the reason spelled out. Nothing is hidden or
// blocked; a tracker only partly covered is left exactly as the server sent it.
//
// ── Multi-project tasks ─────────────────────────────────────────────────────
//
// A task can span several projects, and each time entry bills to one of them,
// so one task yields one line PER PROJECT (per day, in the daily layout) — each
// priced at its own project's rate. The print view shows consecutive lines of
// the same task (and day) under one task heading with a project sub-row each,
// so both layouts keep those lines adjacent: the daily sort breaks ties on
// task id then project name, and the task layout runs
// `keepTaskProjectLinesAdjacent`.
//
// Nothing about the stored invoice changes. A daily line is an ordinary
// InvoiceLine whose date_from === date_to and whose session_ids are that day's
// entries, so the server stores it, claims its entries and recomputes its
// money exactly as it does any other line.
//
// No money arithmetic here. Hours are re-summed from each entry's
// `effective_hours` — the server's own per-entry figure, the same one the
// preview summed — and `amount` is left to the server and `computeMoney`.
//
// Front only for now: mobile still builds per-task lines straight from the
// preview — no notes attached, no trackers left off. The regenerate merge takes
// the layout as a parameter defaulting to 'task', and keeps stored bullets
// whenever fresh ones are empty, so the shared copy of `regenerate.ts` behaves
// on mobile exactly as it did.

import type { InvoiceLine, InvoicePreviewLine, Session, Tracker } from '../types';
import { lineSourceKey, type InvoiceLineLayout } from './regenerate';

/** Leading bullet or numbering — the same shapes `taskPaste.ts` strips. */
const BULLET = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

const STORAGE_KEY = 'invoice_line_layout';

/**
 * Turn time entry notes into sub-items: one per non-blank line, with any
 * leading bullet or number removed so "- Fixed login" prints as one bullet,
 * not a bullet holding a dash.
 *
 * Lines are kept whole. Unlike `parseTaskList` this does not cut sentences
 * apart — a note is already laid out the way its author wanted it listed.
 */
export function notesToSubItems(notes: string | null | undefined): string[] {
  return (notes ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET, '').trim())
    .filter(Boolean);
}

/** `invoice_ids`/`invoice_numbers`, falling back to the legacy scalar pair. */
function claimsOf(entry: Session): Array<{ id: string; number: string }> {
  const ids = (entry.invoice_ids ?? []).filter(Boolean);
  if (ids.length > 0) {
    return ids.map((id, index) => ({ id, number: entry.invoice_numbers?.[index] ?? '' }));
  }
  return entry.invoice_id ? [{ id: entry.invoice_id, number: entry.invoice_number ?? '' }] : [];
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The SGT day an entry is billed on — the server's `start_time[:10]`. */
function entryDay(entry: Session): string {
  return entry.start_time.slice(0, 10);
}

/**
 * The bullet list for a set of entries: every note line, in the order given.
 *
 * Two entries can repeat a note line ("- Standup"); it prints once. Compared
 * case-insensitively, keeping the first spelling seen.
 */
function subItemsFromNotes(entries: Session[]): string[] {
  const subItems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const item of notesToSubItems(entry.notes)) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      subItems.push(item);
    }
  }
  return subItems;
}

/**
 * A time-entry line's entries, or null when it has none or any is unknown.
 *
 * Null covers tracker lines too: they bill a span and claim no entries.
 */
function entriesOf(line: InvoicePreviewLine, sessionsById: Map<string, Session>): Session[] | null {
  const ids = line.session_ids ?? [];
  if (line.tracker_id || ids.length === 0) return null;
  const entries: Session[] = [];
  for (const id of ids) {
    const entry = sessionsById.get(id);
    if (entry === undefined) return null;
    entries.push(entry);
  }
  return entries;
}

/**
 * Give each per-task line its time entries' notes as `sub_items` — the 'task'
 * layout's counterpart to `expandToDailyLines`.
 *
 * Entries are read in start-time order, so the bullets follow the work as it
 * was logged. A line whose entries have no notes gets `[]`, which is what the
 * preview sent anyway; the regenerate merge reads that as "nothing to refresh"
 * and keeps any list typed onto the invoice by hand.
 *
 * Like the daily layout, a line whose entries are not all in `sessionsById` is
 * passed through untouched: a bullet list built from some of its entries would
 * look complete and not be.
 */
export function attachNotesToTaskLines(
  lines: InvoicePreviewLine[],
  sessionsById: Map<string, Session>,
): InvoicePreviewLine[] {
  return lines.map((line) => {
    const entries = entriesOf(line, sessionsById);
    if (entries === null) return line;
    const ordered = [...entries].sort((a, b) => byCodePoint(a.start_time, b.start_time));
    return { ...line, sub_items: subItemsFromNotes(ordered) };
  });
}

/**
 * Re-cut a preview's time-entry lines one per day.
 *
 * Each (task, project) line is split by the SGT date of its entries' start
 * times — the same `start_time[:10]` the server dates them by — and every
 * piece inherits the line's rate, names and duplicate verdict. Tracker lines
 * and lines without entries pass through untouched.
 *
 * A line whose entries are not all in `sessionsById` is also passed through
 * whole rather than split partially: dropping the unknown entries would
 * quietly bill fewer hours than the preview found.
 *
 * `forInvoiceId` hides that invoice's own claims, as the preview's
 * `for_invoice_id` does, so Regenerate does not flag an invoice's entries as
 * already billed — by itself.
 *
 * Sorted as the server sorts: date, then task title, by code point.
 */
export function expandToDailyLines(
  lines: InvoicePreviewLine[],
  sessionsById: Map<string, Session>,
  forInvoiceId?: string | null,
): InvoicePreviewLine[] {
  const result: InvoicePreviewLine[] = [];

  for (const line of lines) {
    const entries = entriesOf(line, sessionsById);
    if (entries === null) {
      result.push(line);
      continue;
    }

    const days = new Map<string, Session[]>();
    for (const entry of entries) {
      const day = entryDay(entry);
      const bucket = days.get(day);
      if (bucket) bucket.push(entry);
      else days.set(day, [entry]);
    }

    for (const [day, dayEntries] of days) {
      dayEntries.sort((a, b) => byCodePoint(a.start_time, b.start_time));

      const subItems = subItemsFromNotes(dayEntries);
      let claimed = 0;
      const claimedBy: string[] = [];
      for (const entry of dayEntries) {
        const claims = claimsOf(entry).filter((claim) => claim.id !== forInvoiceId);
        if (claims.length > 0) claimed += 1;
        for (const claim of claims) {
          const label = claim.number || claim.id;
          if (!claimedBy.includes(label)) claimedBy.push(label);
        }
      }

      result.push({
        ...line,
        line_id: crypto.randomUUID(),
        date_from: day,
        date_to: day,
        hours: dayEntries.reduce((sum, entry) => sum + (entry.effective_hours ?? 0), 0),
        // The per-task figure no longer describes this piece. Every surface
        // recomputes it, and the server ignores it on write.
        amount: 0,
        session_ids: dayEntries.map((entry) => entry.id),
        sub_items: subItems,
        claimed_entry_count: claimed,
        claimed_by: claimedBy,
      });
    }
  }

  // Date, then task title, as the server sorts — then task id and project
  // name, so two tasks sharing a title never interleave and one task's
  // project lines for a day stay together.
  return result.sort(
    (a, b) =>
      byCodePoint(a.date_from ?? '', b.date_from ?? '') ||
      byCodePoint(a.task_title ?? '', b.task_title ?? '') ||
      byCodePoint(a.task_id ?? '', b.task_id ?? '') ||
      byCodePoint(a.project_name ?? '', b.project_name ?? ''),
  );
}

/**
 * Pull every later time-entry line of a task up behind that task's first
 * line, so a multi-project task's per-project lines sit together and print
 * under one heading. Otherwise the order is untouched (stable): tracker lines
 * and lines without a task never move and never gather others.
 */
export function keepTaskProjectLinesAdjacent<T extends InvoiceLine>(lines: T[]): T[] {
  const buckets = new Map<string, T[]>();
  const order: Array<T | T[]> = [];
  for (const line of lines) {
    if (line.tracker_id || !line.task_id) {
      order.push(line);
      continue;
    }
    const bucket = buckets.get(line.task_id);
    if (bucket) {
      bucket.push(line);
    } else {
      const fresh = [line];
      buckets.set(line.task_id, fresh);
      order.push(fresh);
    }
  }
  return order.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

/** Shown on a tracker line left off because its time entries bill the day. */
export const COVERED_TRACKER_REASON =
  'Its tasks are billed by their time entries on this day (listed as their own lines, with their notes). ' +
  'Billing both charges the day twice.';

/**
 * Untick every tracker line whose day the time-entry lines already bill.
 *
 * A tracker line is covered when EVERY task on the tracker has at least one
 * entry that (a) sits in some non-tracker line's `session_ids` in this same
 * array, so it really is being billed here, and (b) starts on the tracker
 * line's `date_from`. Run it on the lines as finally laid out — a daily line
 * counts exactly as a per-task one does.
 *
 * Paired by (task, day) and not by the entry's `tracker_id`: that link is only
 * set when the tracker itself created the entry, and an entry logged by hand
 * against the tracker's task — the common case — has none. That gap is what let
 * the server's own duplicate check miss these.
 *
 * All-or-nothing on purpose. A tracker with one task covered and one not still
 * holds unbilled work, and the owner has to decide how to bill it, so it is
 * left exactly as the server sent it. Likewise a tracker missing from
 * `trackersById`, or with no tasks, is never guessed at.
 *
 * A line the server already unticked keeps its own reason: the first verdict
 * is the one that explains it (a running tracker has no hours at all).
 */
export function markTrackersCoveredByEntries(
  lines: InvoicePreviewLine[],
  sessionsById: Map<string, Session>,
  trackersById: Map<string, Tracker>,
): InvoicePreviewLine[] {
  const billedTaskDays = new Set<string>();
  for (const line of lines) {
    if (line.tracker_id) continue;
    for (const id of line.session_ids ?? []) {
      const entry = sessionsById.get(id);
      if (entry) billedTaskDays.add(`${entry.task_id}|${entryDay(entry)}`);
    }
  }
  if (billedTaskDays.size === 0) return lines;

  return lines.map((line) => {
    if (!line.tracker_id || line.include_by_default === false || !line.date_from) return line;
    const tasks = trackersById.get(line.tracker_id)?.tasks ?? [];
    if (tasks.length === 0) return line;
    const covered = tasks.every((task) => billedTaskDays.has(`${task.task_id}|${line.date_from}`));
    if (!covered) return line;
    return { ...line, include_by_default: false, duplicate_reason: COVERED_TRACKER_REASON };
  });
}

/**
 * Split a regenerate's fresh lines into those the merge should see and those
 * left off.
 *
 * The builder shows an unticked line and lets the owner tick it. Regenerate
 * has no ticks — the merge adds every unmatched line — so an unticked line has
 * to be set aside before merging, or a tracker left off for charging the day
 * twice would be added straight back onto the invoice.
 *
 * Except when the invoice already carries that line (same source key): then
 * the owner put or kept it there deliberately, and it goes through the merge
 * like any other line rather than being reported as removed.
 *
 * Returned, not discarded, so the dialog can say what was left off and why.
 */
export function setAsideLeftOffLines(
  current: InvoiceLine[],
  fresh: InvoicePreviewLine[],
  layout: InvoiceLineLayout = 'task',
): { lines: InvoicePreviewLine[]; leftOff: InvoicePreviewLine[] } {
  const storedKeys = new Set(
    current.map((line) => lineSourceKey(line, layout)).filter((key): key is string => key !== null),
  );
  const lines: InvoicePreviewLine[] = [];
  const leftOff: InvoicePreviewLine[] = [];
  for (const line of fresh) {
    const key = lineSourceKey(line, layout);
    if (line.include_by_default === false && (key === null || !storedKeys.has(key))) {
      leftOff.push(line);
    } else {
      lines.push(line);
    }
  }
  return { lines, leftOff };
}

/**
 * The layout an existing invoice was built with, as far as its lines can tell.
 *
 * Only lines billing time entries count. When every one covers a single day
 * the invoice reads as daily; any multi-day line means per-task. With no such
 * lines there is nothing to go on, and null says so.
 *
 * A guess, and only a default — the owner can switch before loading.
 */
export function inferLayout(lines: InvoiceLine[]): InvoiceLineLayout | null {
  const entryLines = lines.filter(
    (line) => !line.tracker_id && line.task_id && (line.session_ids ?? []).length > 0,
  );
  if (entryLines.length === 0) return null;
  return entryLines.every((line) => line.date_from && line.date_from === line.date_to)
    ? 'daily'
    : 'task';
}

/** The layout last chosen in this browser, or 'task' — the preview's own shape. */
export function rememberedLayout(): InvoiceLineLayout {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'daily' ? 'daily' : 'task';
  } catch {
    return 'task';
  }
}

export function rememberLayout(layout: InvoiceLineLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    // Storage blocked (private window). The choice still applies to this dialog.
  }
}
