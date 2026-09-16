// Grouping invoice lines under their task, for display.
//
// A task can link several projects, and the invoice preview prices one line per
// (task, project) — each at its own project's rate. Shown flat, that reads as
// the same task billed twice. So consecutive lines that share a `task_id` (and,
// when the lines are daily — `date_from === date_to` — the same day) render as
// one task heading with a project sub-row per line. The same rule as the web's
// `InvoicePrintView`.
//
// Display only. Nothing here changes the lines, their order or their stored
// shape; each sub-row is still the ordinary editable `LineCard`, and every
// amount on screen is still the stored figure (or the unsaved `computeMoney`
// preview). The heading's hours are a display sum of the lines' hours,
// quantised the way `lib/money.ts` does — never an amount, never saved.
//
// Not grouped: tracker lines (`tracker_id` set), hand-added lines with no task,
// and a run of one — which renders exactly as it did before.

import { parseNumberInput } from '@/components';
import { totalHoursFromLines } from '@/lib/money';

import type { LineDraft } from './draft';

export interface LineGroup {
  /** Stable React key: the first line's key. */
  key: string;
  lines: LineDraft[];
  /** True for a task heading over two or more project sub-rows. */
  grouped: boolean;
  task_title: string;
  date_from: string | null;
  date_to: string | null;
  /** Display sum of the lines' hours, 2 dp. */
  hours: number;
}

function groupKey(line: LineDraft): string | null {
  if (line.tracker_id !== null || !line.task_id) return null;
  const daily = line.date_from !== null && line.date_from === line.date_to;
  return daily ? `${line.task_id}|day|${line.date_from}` : `${line.task_id}|span`;
}

function minDay(days: Array<string | null>): string | null {
  return days.filter((d): d is string => !!d).sort()[0] ?? null;
}

function maxDay(days: Array<string | null>): string | null {
  const sorted = days.filter((d): d is string => !!d).sort();
  return sorted[sorted.length - 1] ?? null;
}

export function groupLines(lines: LineDraft[]): LineGroup[] {
  const runs: LineDraft[][] = [];
  let previousKey: string | null = null;

  for (const line of lines) {
    const key = groupKey(line);
    const run = runs[runs.length - 1];
    if (run && key !== null && key === previousKey) run.push(line);
    else runs.push([line]);
    previousKey = key;
  }

  return runs.map((run) => ({
    key: run[0].key,
    lines: run,
    grouped: run.length > 1,
    task_title: run[0].task_title.trim() || run[0].description.trim(),
    date_from: minDay(run.map((line) => line.date_from)),
    date_to: maxDay(run.map((line) => line.date_to)),
    hours: totalHoursFromLines(run.map((line) => ({ hours: parseNumberInput(line.hours) ?? 0 }))),
  }));
}
