// The card the app exists for: what is running, for how long, and on what.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import { Button, Card, Chip, ConfirmSheet } from '@/components';
import { formatElapsed, formatSgtDateTime, parseSgt } from '@/lib/sgt';
import type { Tracker, TrackerTaskRef } from '@/types';

import { isFuture } from './trackerTime';
import { useTick } from './useTick';

export interface ActiveTrackerCardProps {
  tracker: Tracker;
  /** How many *other* trackers are running. Only ever non-zero via the web. */
  otherActiveCount: number;
  onStop: () => Promise<void>;
  onAddTasks: () => void;
  /** Rejecting keeps the confirmation open and shows why — see `ConfirmSheet`. */
  onRemoveTask: (taskId: string) => Promise<void>;
}

export default function ActiveTrackerCard({
  tracker,
  otherActiveCount,
  onStop,
  onAddTasks,
  onRemoveTask,
}: ActiveTrackerCardProps) {
  const running = !tracker.end_time;
  // One confirmation for the whole list; the row being removed is the state.
  const [removeTarget, setRemoveTarget] = useState<TrackerTaskRef | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');

  const now = useTick(running);
  const until = running ? now : (parseSgt(tracker.end_time) ?? now);
  const elapsed = formatElapsed(tracker.start_time, until);

  // A start time in the future is the user's call (§ no locking). It is said
  // out loud rather than corrected — the clock reads 00:00:00 until it passes.
  const startInFuture = isFuture(tracker.start_time, now);

  async function handleStop() {
    setStopping(true);
    setStopError('');
    try {
      await onStop();
    } catch (e) {
      setStopError(apiErrorMessage(e, 'Could not stop the tracker. Try again.'));
    } finally {
      setStopping(false);
    }
  }

  return (
    <Card highlight={running} className="gap-4">
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Chip label={running ? 'Running' : 'Stopped'} tone={running ? 'green' : 'slate'} />
          {tracker.invoice_numbers.length > 0 ? (
            // A badge, not a lock — the tracker stays fully editable.
            <Chip label={`On ${tracker.invoice_numbers.join(', ')}`} tone="indigo" />
          ) : null}
        </View>

        <Text className="text-lg font-semibold leading-snug text-slate-100">{tracker.title}</Text>

        <Text className="text-4xl font-semibold tracking-wider text-slate-100">{elapsed}</Text>

        <Text className="text-xs text-slate-500">
          {formatSgtDateTime(tracker.start_time)}
          {tracker.end_time ? ` → ${formatSgtDateTime(tracker.end_time)}` : ' → now'}
        </Text>

        {startInFuture ? (
          <Text className="text-xs text-amber-300">
            This tracker starts in the future, so the clock stays at 00:00:00 until then. Edit the
            start time on the web if that was not intended.
          </Text>
        ) : null}

        {tracker.notes ? (
          <Text className="text-sm text-slate-400">{tracker.notes}</Text>
        ) : null}
      </View>

      {running ? (
        <View className="gap-2">
          <Button
            label="Stop tracker"
            variant="secondary"
            size="lg"
            loading={stopping}
            onPress={handleStop}
          />
          {stopError ? <Text className="text-xs text-red-400">{stopError}</Text> : null}
        </View>
      ) : (
        <Text className="text-xs text-slate-500">
          Stopped. Create its time entries below, or start a new tracker.
        </Text>
      )}

      {otherActiveCount > 0 ? (
        <Text className="text-xs text-amber-300">
          {otherActiveCount === 1
            ? 'One other tracker is also running.'
            : `${otherActiveCount} other trackers are also running.`}{' '}
          This screen shows the most recently started one; the rest are on the web.
        </Text>
      ) : null}

      <View className="gap-2 border-t border-slate-800 pt-4">
        <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Tasks in block ({tracker.tasks.length})
        </Text>

        {tracker.tasks.length === 0 ? (
          <Text className="py-1 text-sm text-slate-500">
            No tasks yet. A block needs at least one before its time can be billed.
          </Text>
        ) : (
          tracker.tasks.map((task) => (
            <View
              key={task.task_id}
              className="flex-row items-center gap-2 border-b border-slate-800/70 py-2"
            >
              <Text className="text-sm text-slate-500">•</Text>
              <View className="flex-1">
                <Text className="text-sm text-slate-100">{task.task_title}</Text>
                <Text className="text-xs text-slate-500" numberOfLines={1}>
                  {[task.project_name, task.client_name].filter(Boolean).join(' · ') || '—'}
                </Text>
              </View>
              <Pressable
                onPress={() => setRemoveTarget(task)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${task.task_title} from this block`}
              >
                <Text className="px-1 text-base text-slate-500">✕</Text>
              </Pressable>
            </View>
          ))
        )}

        <Button label="+ Add task" variant="secondary" onPress={onAddTasks} className="mt-2" />
      </View>

      <ConfirmSheet
        open={removeTarget !== null}
        title="Remove from this block?"
        message={
          removeTarget
            ? `"${removeTarget.task_title}" will no longer be part of this tracker.`
            : ''
        }
        detail="The task itself is not deleted, and any time entries already created from this tracker are left alone."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removeTarget) await onRemoveTask(removeTarget.task_id);
        }}
        onClose={() => setRemoveTarget(null)}
        errorFallback="Could not remove the task. Try again."
      />
    </Card>
  );
}
