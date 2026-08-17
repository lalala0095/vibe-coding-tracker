// What a row opens.
//
// Until there was somewhere to go, the card body was deliberately not pressable
// — a tap target that opens nothing is worse than none. This is that somewhere:
// the fields the list has no room for (description, parent, timestamps) and the
// three actions a task now has.
//
// It reads; it does not write. Every action hands back to the screen, which
// owns the task list and swaps this sheet for the form or the delete
// confirmation. That keeps exactly one modal on screen at a time and means
// nothing typed can be lost by tapping through to another action, because
// nothing here is typed.

import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { Button, Chip } from '@/components';
import { formatSgtDateTime } from '@/lib/sgt';
import type { Task } from '@/types';

import { directChildren } from './rows';
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  dueDateClass,
  formatDueDate,
} from './taskMeta';

export interface TaskDetailSheetProps {
  /** `null` closes the sheet — a deleted task stops resolving mid-render. */
  task: Task | null;
  /** Every loaded task: the parent's title and the sub-task count. */
  tasks: Task[];
  /** Today's Singapore date, `YYYY-MM-DD`, for the overdue colour. */
  today: string;
  /** The same one-tap cycle the row has, so the gesture works in both places. */
  onCycleStatus: (task: Task) => void;
  onEdit: (task: Task) => void;
  onAddSubTask: (task: Task) => void;
  onDelete: (task: Task) => void;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</Text>
      {children}
    </View>
  );
}

export default function TaskDetailSheet({
  task,
  tasks,
  today,
  onCycleStatus,
  onEdit,
  onAddSubTask,
  onDelete,
  onClose,
}: TaskDetailSheetProps) {
  const { height } = useWindowDimensions();

  if (!task) return null;

  const children = directChildren(tasks, task.id);
  const parent = task.parent_task_id
    ? (tasks.find((candidate) => candidate.id === task.parent_task_id) ?? null)
    : null;
  const orphaned = task.parent_task_id !== null && parent === null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        {/* Swallows the backdrop press so a tap inside the sheet does not close it. */}
        <Pressable
          onPress={() => {}}
          className="rounded-t-2xl border-t border-slate-800 bg-slate-900"
          style={{ maxHeight: height * 0.9 }}
          testID="task-detail"
        >
          <View className="flex-row items-center justify-between border-b border-slate-800 px-5 py-4">
            <Text className="text-base font-semibold text-slate-100">Task</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <Text className="px-1 text-lg text-slate-400">✕</Text>
            </Pressable>
          </View>

          <ScrollView className="px-5 py-4">
            <View className="gap-4">
              <Text
                className={`text-lg font-semibold leading-snug ${
                  task.status === 'done' ? 'text-slate-500 line-through' : 'text-slate-100'
                }`}
              >
                {task.title}
              </Text>

              <Text className="text-xs text-slate-500">
                {task.client_name} / {task.project_name}
              </Text>

              <View className="flex-row flex-wrap items-center gap-2">
                <Chip
                  label={STATUS_LABEL[task.status]}
                  tone={STATUS_TONE[task.status]}
                  size="md"
                  onPress={() => onCycleStatus(task)}
                  testID="task-detail-status"
                />
                <Chip
                  label={PRIORITY_LABEL[task.priority]}
                  tone={PRIORITY_TONE[task.priority]}
                  size="md"
                />
                {task.due_date ? (
                  <Text className={`text-xs font-medium ${dueDateClass(task.due_date, today)}`}>
                    Due {formatDueDate(task.due_date)}
                  </Text>
                ) : (
                  <Text className="text-xs text-slate-500">No due date</Text>
                )}
              </View>
              <Text className="-mt-2 text-xs text-slate-600">Tap the status to cycle it.</Text>

              <Field label="Description">
                <Text className="text-sm leading-relaxed text-slate-300">
                  {task.description.trim() ? task.description : '—'}
                </Text>
              </Field>

              <Field label="Parent task">
                {parent ? (
                  <Text className="text-sm text-slate-300">{parent.title}</Text>
                ) : orphaned ? (
                  <Text className="text-sm text-amber-400">
                    Its parent no longer exists. Edit this task to clear or re-point it.
                  </Text>
                ) : (
                  <Text className="text-sm text-slate-500">Top-level task</Text>
                )}
              </Field>

              <Field label="Sub-tasks">
                <Text className="text-sm text-slate-300">
                  {children.length === 0
                    ? 'None'
                    : `${children.length} ${children.length === 1 ? 'sub-task' : 'sub-tasks'}`}
                </Text>
              </Field>

              {task.attachments.length > 0 ? (
                <Field label="Attachments">
                  <Text className="text-sm text-slate-300">
                    {task.attachments.length}{' '}
                    {task.attachments.length === 1 ? 'file' : 'files'} — open the web app to view
                    them.
                  </Text>
                </Field>
              ) : null}

              <Text className="text-xs text-slate-600">
                Added {formatSgtDateTime(task.datetime_inserted)} · updated{' '}
                {formatSgtDateTime(task.datetime_updated)}
              </Text>
            </View>
          </ScrollView>

          <View className="gap-3 border-t border-slate-800 px-5 py-4">
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button label="Edit" onPress={() => onEdit(task)} testID="task-detail-edit" />
              </View>
              <View className="flex-1">
                <Button
                  label="Add sub-task"
                  onPress={() => onAddSubTask(task)}
                  variant="secondary"
                  testID="task-detail-add-sub"
                />
              </View>
            </View>
            <Button
              label="Delete task"
              onPress={() => onDelete(task)}
              variant="ghost"
              textClassName="text-red-400"
              testID="task-detail-delete"
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
