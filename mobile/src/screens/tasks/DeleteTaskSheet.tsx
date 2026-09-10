// The delete confirmation, and the one place that says what deleting actually
// does.
//
// `DELETE /tasks/{id}` removes the document and its GCS attachments. **There is
// no cascade.** Two things survive it, both of them silently:
//
//   - sub-tasks keep a `parent_task_id` that no longer resolves. They do not
//     disappear; they surface at the top of this list flagged "Sub-task",
//     because `buildTaskRows` treats a child with no visible parent as a
//     detached root.
//   - time entries keep the denormalised `task_title` they were written with
//     and stay billable, so hours already logged against this task still reach
//     an invoice.
//
// Neither is a reason to block the delete — CLAUDE.md is explicit that this app
// warns and never blocks. It is a reason to count them and say so first, which
// is what the extra `getSessions` call below buys.

import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { getSessions } from '@/api';
import { ConfirmSheet } from '@/components';
import type { Task } from '@/types';

import { descendantIds, directChildren } from './rows';

export interface DeleteTaskSheetProps {
  /** `null` renders nothing. */
  task: Task | null;
  /** Every loaded task — the orphan count comes from the list already in hand. */
  tasks: Task[];
  /** Throwing keeps the sheet open and shows the message. */
  onConfirm: (task: Task) => Promise<void>;
  onClose: () => void;
}

type EntryCount =
  | { state: 'loading' }
  | { state: 'ready'; count: number }
  | { state: 'unknown' };

export default function DeleteTaskSheet({ task, tasks, onConfirm, onClose }: DeleteTaskSheetProps) {
  const taskId = task?.id ?? null;
  const [entries, setEntries] = useState<EntryCount>({ state: 'loading' });

  // One request, for the one task being deleted, only while the sheet is open.
  // Counting entries per row on the list would be a request per row; counting
  // them here is a single call at the moment the number actually matters.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setEntries({ state: 'loading' });

    getSessions({ task_id: taskId })
      .then((rows) => {
        if (!cancelled) setEntries({ state: 'ready', count: rows.length });
      })
      .catch(() => {
        // A failed count must not stand in the way of the delete, and must not
        // claim there are none either.
        if (!cancelled) setEntries({ state: 'unknown' });
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!task) return null;

  const children = directChildren(tasks, task.id);
  const branch = descendantIds(tasks, task.id);

  const childLine =
    children.length === 0
      ? null
      : `${children.length} ${children.length === 1 ? 'sub-task' : 'sub-tasks'}` +
        (branch.size > children.length ? ` (${branch.size} in the whole branch)` : '') +
        ' will be left pointing at a task that no longer exists. They are not deleted — they' +
        ' reappear at the top of this list marked “Sub-task”.';

  const entryLine =
    entries.state === 'loading'
      ? 'Checking for time entries…'
      : entries.state === 'unknown'
        ? 'Could not check for time entries. Any that exist keep their hours and stay billable.'
        : entries.count === 0
          ? 'No time entries are logged against it.'
          : `${entries.count} ${entries.count === 1 ? 'time entry keeps its' : 'time entries keep their'} hours and stay billable — they hold the task title as text, not a link.`;

  return (
    <ConfirmSheet
      open
      title="Delete task"
      message={`Delete “${task.title}”? Its attachments go with it. This cannot be undone.`}
      detail={
        <View className="gap-2">
          {childLine ? <Text className="text-xs leading-relaxed text-amber-400">{childLine}</Text> : null}
          <Text className="text-xs leading-relaxed text-slate-400">{entryLine}</Text>
        </View>
      }
      confirmLabel="Delete task"
      onConfirm={() => onConfirm(task)}
      onClose={onClose}
      errorFallback="Could not delete that task."
      testID="task-delete-confirm"
    />
  );
}
