// One work block, folded up.
//
// The web's Trackers page is a list on the left and a detail panel on the
// right. A phone has one column, so the hierarchy is the layout, the same way
// `src/screens/clients/ClientCard.tsx` handles clients and their projects:
// collapsed is the summary you scan a history with, expanded is the block's
// tasks and everything you can do to it.
//
// The clock is passed in rather than kept here. One `useTick` on the screen
// drives every row, so a list of thirty trackers is still one interval — and
// `useTick` stops it when the screen loses focus.

import { Pressable, Text, View } from 'react-native';

import { Card, Chip } from '@/components';
import type { Tracker, TrackerTaskRef } from '@/types';

import { durationLabel, endsBeforeStart, isRunning, spanLabel, taskCountLabel } from './trackerRows';

export interface TrackerRowProps {
  tracker: Tracker;
  /** Refreshed once a second by the screen while anything is running. */
  now: Date;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAddTasks: () => void;
  onBill: () => void;
  onDelete: () => void;
  onRemoveTask: (task: TrackerTaskRef) => void;
}

/** A small bordered text button. The action row uses several in a line. */
function RowAction({
  label,
  onPress,
  tone = 'slate',
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: 'slate' | 'blue' | 'red';
  testID?: string;
}) {
  const border =
    tone === 'red' ? 'border-red-500/40 active:bg-red-500/10'
    : tone === 'blue' ? 'border-blue-500/40 active:bg-blue-500/10'
    : 'border-slate-700 active:bg-slate-800';
  const text =
    tone === 'red' ? 'text-red-400' : tone === 'blue' ? 'text-blue-400' : 'text-slate-300';

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      className={`rounded-lg border px-3 py-1.5 ${border}`}
      testID={testID}
    >
      <Text className={`text-xs font-medium ${text}`}>{label}</Text>
    </Pressable>
  );
}

export default function TrackerRow({
  tracker,
  now,
  expanded,
  onToggle,
  onEdit,
  onAddTasks,
  onBill,
  onDelete,
  onRemoveTask,
}: TrackerRowProps) {
  const running = isRunning(tracker);
  const billed = tracker.invoice_numbers.length > 0;
  const backwards = endsBeforeStart(tracker);

  return (
    <Card padded={false} highlight={running}>
      {/* The whole header is the toggle — a chevron-sized target is not one. */}
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${tracker.title}, ${running ? 'running' : 'stopped'}, ${taskCountLabel(tracker)}`}
        className="flex-row items-start gap-3 px-4 py-4 active:bg-slate-800"
      >
        <View className="min-w-0 flex-1 gap-2">
          <View className="flex-row flex-wrap items-center gap-2">
            <Chip label={running ? 'Running' : 'Done'} tone={running ? 'green' : 'slate'} />
            {billed ? (
              // A badge, not a lock — every field on this tracker stays
              // editable (CLAUDE.md § no locking).
              <Chip label={`On ${tracker.invoice_numbers.join(', ')}`} tone="indigo" />
            ) : null}
          </View>

          <Text className="text-base font-semibold leading-snug text-slate-100" numberOfLines={2}>
            {tracker.title}
          </Text>

          <Text className="text-xs text-slate-500" numberOfLines={1}>
            {spanLabel(tracker)}
          </Text>

          <View className="flex-row items-baseline gap-2">
            <Text className="text-base font-semibold tabular-nums text-slate-100">
              {durationLabel(tracker, now)}
            </Text>
            <Text className="text-xs text-slate-500">{taskCountLabel(tracker)}</Text>
          </View>
        </View>

        {/* No icon library in this app — glyphs are text characters. */}
        <Text className="pt-0.5 text-lg leading-none text-slate-500">{expanded ? '⌄' : '›'}</Text>
      </Pressable>

      {expanded ? (
        <View className="border-t border-slate-800">
          <View className="gap-3 px-4 py-3">
            {backwards ? (
              <Text className="text-xs leading-relaxed text-amber-300">
                This block ends before it starts, so its clock reads 00:00:00. Stored exactly as
                entered — edit the times if that was not intended.
              </Text>
            ) : null}

            {billed ? (
              <Text className="text-xs leading-relaxed text-amber-300">
                Already billed on {tracker.invoice_numbers.join(', ')} as its own line. Time
                entries created from it are billed separately, so check you are not putting the
                same hours on an invoice twice.
              </Text>
            ) : null}

            {tracker.notes ? (
              <Text className="text-sm leading-relaxed text-slate-400">{tracker.notes}</Text>
            ) : null}

            <View className="flex-row flex-wrap gap-2">
              <RowAction label="Edit" onPress={onEdit} testID={`tracker-edit-${tracker.id}`} />
              <RowAction label="+ Add tasks" onPress={onAddTasks} tone="blue" />
              <RowAction label="Create time entries" onPress={onBill} tone="blue" />
              <RowAction label="Delete" onPress={onDelete} tone="red" testID={`tracker-delete-${tracker.id}`} />
            </View>
          </View>

          <View className="border-t border-slate-800/70 px-4 py-3">
            <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Tasks in block ({tracker.tasks.length})
            </Text>

            {tracker.tasks.length === 0 ? (
              <Text className="pt-2 text-xs leading-relaxed text-slate-500">
                No tasks yet. A block needs at least one before its time can become time entries.
              </Text>
            ) : (
              tracker.tasks.map((task) => (
                <View
                  key={task.task_id}
                  className="flex-row items-center gap-2 border-b border-slate-800/70 py-2"
                >
                  <Text className="text-sm text-slate-500">•</Text>
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm text-slate-100" numberOfLines={2}>
                      {task.task_title}
                    </Text>
                    <Text className="text-xs text-slate-500" numberOfLines={1}>
                      {[task.project_name, task.client_name].filter(Boolean).join(' · ') || '—'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => onRemoveTask(task)}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${task.task_title} from this block`}
                  >
                    <Text className="px-1 text-base text-slate-500">✕</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </View>
      ) : null}
    </Card>
  );
}
