// How the printed invoice groups its lines — one task heading over that task's
// per-project lines.
//
// A task can span several projects, and the invoice bills each project on its
// own line at its own rate (the preview groups entries by (task, project)).
// Printed flat, that reads as the same task twice. So consecutive lines that
// share a `task_id` — and, when the lines are daily (date_from === date_to),
// the same date — print as ONE group: a heading with the task title, the
// group's dates and its hours, then an indented sub-row per project carrying
// that line's stored hours, rate, amount and bullets.
//
// Rules:
// - Only CONSECUTIVE lines group. The builder keeps them adjacent
//   (`invoiceLayout.ts`); an owner who reorders them apart gets them printed
//   apart, which is what the order they chose says.
// - Tracker lines (tracker_id set) and lines without a task never group.
// - A daily line and a multi-day line never share a group.
// - A group of one line prints exactly as an ungrouped line always has.
// - No money here. The heading's hours are a DISPLAY sum of the stored line
//   hours, each quantised to 2 dp first (`totalHoursFromLines`, as money.ts
//   sums). Amounts and every stored total are printed verbatim elsewhere and
//   never recomputed.

import type { InvoiceLine } from '../types';
import { totalHoursFromLines } from './money';

export interface PrintLineGroup {
  /** Stable React key: the first line's id. */
  key: string;
  lines: InvoiceLine[];
  /** Heading text for a multi-line group. */
  title: string;
  date_from: string | null;
  date_to: string | null;
  /** Display-only sum of the lines' stored hours. */
  hours: number;
}

function isDaily(line: InvoiceLine): boolean {
  return Boolean(line.date_from) && line.date_from === line.date_to;
}

function canJoin(group: InvoiceLine[], line: InvoiceLine): boolean {
  const first = group[0];
  if (!first.task_id || first.tracker_id) return false;
  if (!line.task_id || line.tracker_id) return false;
  if (line.task_id !== first.task_id) return false;
  if (isDaily(first) !== isDaily(line)) return false;
  if (isDaily(first) && line.date_from !== first.date_from) return false;
  return true;
}

function minDate(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => Boolean(v));
  return present.length === 0 ? null : present.reduce((a, b) => (b < a ? b : a));
}

function maxDate(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => Boolean(v));
  return present.length === 0 ? null : present.reduce((a, b) => (b > a ? b : a));
}

export function groupLinesForPrint(lines: InvoiceLine[]): PrintLineGroup[] {
  const runs: InvoiceLine[][] = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && canJoin(last, line)) last.push(line);
    else runs.push([line]);
  }
  return runs.map((run) => {
    const first = run[0];
    return {
      key: first.line_id,
      lines: run,
      // The task snapshot names the task; a hand-edited description belongs
      // to its own project row.
      title: first.task_title || first.description,
      date_from: minDate(run.map((l) => l.date_from)),
      date_to: maxDate(run.map((l) => l.date_to)),
      hours: totalHoursFromLines(run),
    };
  });
}
