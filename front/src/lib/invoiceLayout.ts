// How time entries are cut into invoice lines — shared by the builder and
// Regenerate.
//
// The preview endpoint groups billable time entries by (task, project): one
// line per task, hours summed across the whole period, no bullets under it.
// That suits a long-running task and reads badly for a day-by-day log. The
// 'daily' layout re-cuts those same lines one per task per day, and turns each
// day's time entry notes into the bullet list under it — the per-day detail a
// tracker line gives, without creating a nested task for every item.
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
// Front only for now: mobile still builds per-task lines. The regenerate merge
// takes the layout as a parameter defaulting to 'task', so the shared copy of
// `regenerate.ts` behaves on mobile exactly as it did.

import type { InvoiceLine, InvoicePreviewLine, Session } from '../types';
import type { InvoiceLineLayout } from './regenerate';

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
    const ids = line.session_ids ?? [];
    const entries = ids.map((id) => sessionsById.get(id));
    if (line.tracker_id || ids.length === 0 || entries.some((entry) => entry === undefined)) {
      result.push(line);
      continue;
    }

    const days = new Map<string, Session[]>();
    for (const entry of entries as Session[]) {
      const day = entry.start_time.slice(0, 10);
      const bucket = days.get(day);
      if (bucket) bucket.push(entry);
      else days.set(day, [entry]);
    }

    for (const [day, dayEntries] of days) {
      dayEntries.sort((a, b) => byCodePoint(a.start_time, b.start_time));

      // Two entries on one day can repeat a note line; it prints once.
      const subItems: string[] = [];
      const seen = new Set<string>();
      let claimed = 0;
      const claimedBy: string[] = [];
      for (const entry of dayEntries) {
        for (const item of notesToSubItems(entry.notes)) {
          const key = item.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          subItems.push(item);
        }
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

  return result.sort(
    (a, b) =>
      byCodePoint(a.date_from ?? '', b.date_from ?? '') ||
      byCodePoint(a.task_title ?? '', b.task_title ?? ''),
  );
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
