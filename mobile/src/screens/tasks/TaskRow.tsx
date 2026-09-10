// One task in the list.
//
// Two tap targets, deliberately separate:
//
//   the status chip  cycles `todo → in_progress → done → todo`, the gesture the
//                    web's `TaskRow` puts on a checkbox;
//   the card body    opens the task.
//
// The chip is a `Pressable` nested inside the card's own `Pressable`, and React
// Native's responder system gives the innermost one the touch — so cycling a
// status never opens the sheet behind it.

import { memo } from 'react';
import { Text, View } from 'react-native';

import { Card, Chip } from '@/components';
import type { Task } from '@/types';

import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  dueDateClass,
  formatDueDate,
} from './taskMeta';

export interface TaskRowProps {
  task: Task;
  /** Indent level from `buildTaskRows`. */
  depth: number;
  /** A sub-task rendered at depth 0 because its parent is filtered out. */
  detached: boolean;
  /** Off when a project filter already states the client and project. */
  showBreadcrumb: boolean;
  /** Today's Singapore date, `YYYY-MM-DD`, for the overdue colour. */
  today: string;
  onCycleStatus: (task: Task) => void;
  /** Opens the detail sheet — the whole card body. */
  onOpen: (task: Task) => void;
}

function TaskRow({
  task,
  depth,
  detached,
  showBreadcrumb,
  today,
  onCycleStatus,
  onOpen,
}: TaskRowProps) {
  const isDone = task.status === 'done';
  const isSub = depth > 0 || detached;

  return (
    // Indent is arithmetic rather than a class: NativeWind extracts class
    // strings at build time and cannot see a computed one. Layout only.
    <View style={{ paddingLeft: depth * 14 }}>
      <Card className="gap-2" onPress={() => onOpen(task)} testID={`task-row-${task.id}`}>
        <View className="flex-row items-start gap-3">
          {isSub ? <Text className="text-sm text-slate-600">↳</Text> : null}

          <Text
            className={`flex-1 text-sm font-medium leading-snug ${
              isDone ? 'text-slate-500 line-through' : 'text-slate-100'
            }`}
            numberOfLines={3}
          >
            {task.title}
          </Text>

          <Chip
            label={STATUS_LABEL[task.status]}
            tone={STATUS_TONE[task.status]}
            size="md"
            onPress={() => onCycleStatus(task)}
            testID={`task-status-${task.id}`}
          />
        </View>

        {showBreadcrumb ? (
          <Text className="text-xs text-slate-500" numberOfLines={1}>
            {task.client_name} / {task.project_name}
          </Text>
        ) : null}

        <View className="flex-row items-center gap-2">
          <Chip label={PRIORITY_LABEL[task.priority]} tone={PRIORITY_TONE[task.priority]} />

          {detached ? <Chip label="Sub-task" tone="violet" /> : null}

          <View className="ml-auto flex-row items-center gap-2">
            {task.due_date ? (
              <Text className={`text-xs font-medium ${dueDateClass(task.due_date, today)}`}>
                Due {formatDueDate(task.due_date)}
              </Text>
            ) : null}
            {/* The card opens; without this it reads as a static row. */}
            <Text className="text-sm text-slate-600">›</Text>
          </View>
        </View>
      </Card>
    </View>
  );
}

// The list re-renders on every optimistic status flip; memoising keeps that to
// the one row that actually changed.
export default memo(TaskRow);
