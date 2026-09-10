// Labels, tones and the status cycle — the parts of a task's presentation that
// both the row and the filter bar need, kept in one place so the two cannot
// disagree about what colour "urgent" is.

import type { ChipTone } from '@/components';
import type { TaskPriority, TaskStatus } from '@/types';

// ── Status ────────────────────────────────────────────────────────────────────

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'done'];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
};

export const STATUS_TONE: Record<TaskStatus, ChipTone> = {
  todo: 'slate',
  in_progress: 'blue',
  done: 'green',
};

/**
 * The one-tap cycle carried over from the web's `TaskRow`:
 * `todo → in_progress → done → todo`.
 */
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
};

// ── Priority ──────────────────────────────────────────────────────────────────

export const PRIORITY_ORDER: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

// Matching the web's priority dots: slate / blue / orange / red. There is no
// orange in the Chip palette, so high lands on amber.
export const PRIORITY_TONE: Record<TaskPriority, ChipTone> = {
  low: 'slate',
  medium: 'blue',
  high: 'amber',
  urgent: 'red',
};

// ── Due dates ─────────────────────────────────────────────────────────────────
//
// `due_date` is a bare `YYYY-MM-DD` calendar date, not a timestamp. It has no
// time and no instant behind it, so nothing here builds a `Date` from it: doing
// so would attach the phone's timezone to a value that never had one. Both
// helpers are pure string work.

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `2026-08-14` → `14 Aug 2026`. Anything unexpected is shown verbatim. */
export function formatDueDate(due: string): string {
  const [year, month, day] = due.split('-');
  const name = MONTHS[Number(month) - 1];
  if (!year || !name || !Number(day)) return due;
  return `${Number(day)} ${name} ${year}`;
}

/**
 * Overdue red, due-today amber, otherwise the neutral slate.
 *
 * `YYYY-MM-DD` sorts lexicographically in calendar order, so comparing the
 * strings against today's Singapore date is both exact and timezone-free.
 * Classes are written out in full — NativeWind extracts them at build time and
 * cannot see a composed string.
 */
export function dueDateClass(due: string, todayIso: string): string {
  if (due < todayIso) return 'text-red-400';
  if (due === todayIso) return 'text-amber-400';
  return 'text-slate-500';
}
