// Turning a tracker's elapsed time into **Time Entries**.
//
// This is the only route by which tracked time reaches an invoice. The phone
// posts; the server computes. Nothing here does money arithmetic, and nothing
// here recomputes what comes back.
//
// The word "Sessions" appears nowhere in this file on purpose: the `sessions`
// collection is Time Entries, and the UI word "Sessions" belongs to `goals`,
// which this app does not ship.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { apiErrorMessage, getSessions } from '@/api';
import { Button, NumberField, parseNumberInput } from '@/components';
import type { BillTrackerPayload, Session, Tracker } from '@/types';

import Sheet from './Sheet';
import { elapsedHours } from './trackerTime';

export interface BillTrackerSheetProps {
  open: boolean;
  tracker: Tracker;
  onClose: () => void;
  onBill: (payload: BillTrackerPayload) => Promise<Session[]>;
}

type Split = 'even' | 'full';

const SPLITS: ReadonlyArray<readonly [Split, string, string]> = [
  ['even', 'Divide across tasks', "The tracker's hours shared out between them."],
  ['full', 'Full span for each task', 'Each task billed the whole span — work done in parallel.'],
];

/** How far the entered hours may drift from the span before it is worth saying. */
const DRIFT_WARNING_HOURS = 0.5;

export default function BillTrackerSheet({
  open,
  tracker,
  onClose,
  onBill,
}: BillTrackerSheetProps) {
  // The span at the moment the sheet opened. A running tracker keeps counting;
  // this stays put, so the field does not shift under the user mid-edit.
  const [span] = useState<number | null>(() => elapsedHours(tracker));

  const [split, setSplit] = useState<Split>('even');
  const [hours, setHours] = useState(() => (span !== null ? span.toFixed(2) : ''));
  const [billable, setBillable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Session[] | null>(null);
  const [billedTaskIds, setBilledTaskIds] = useState<string[]>([]);

  const running = !tracker.end_time;

  // Best-effort: a failed lookup costs the warning, never the billing. The
  // server bills only tasks it has not already billed from this tracker, so
  // knowing which ones are covered is what makes an empty result explicable.
  const refreshBilled = useCallback(() => {
    getSessions({ tracker_id: tracker.id })
      .then((entries) => setBilledTaskIds(entries.map((entry) => entry.task_id)))
      .catch(() => setBilledTaskIds([]));
  }, [tracker.id]);

  useEffect(() => {
    refreshBilled();
  }, [refreshBilled]);

  const alreadyBilled = useMemo(
    () => tracker.tasks.filter((task) => billedTaskIds.includes(task.task_id)).length,
    [tracker.tasks, billedTaskIds],
  );
  const remaining = tracker.tasks.length - alreadyBilled;

  const parsedHours = parseNumberInput(hours);
  const drift =
    parsedHours !== null && span !== null ? Math.abs(parsedHours - span) : 0;

  const hoursWarning =
    parsedHours !== null && parsedHours < 0
      ? 'These hours are negative. Nothing stops you sending them — check it is what you meant.'
      : drift >= DRIFT_WARNING_HOURS && span !== null
        ? `That is ${drift.toFixed(2)} h away from the tracker's own span of ${span.toFixed(2)} h. Allowed — just checking it was deliberate.`
        : undefined;

  async function handleBill() {
    setSaving(true);
    setError('');
    setCreated(null);
    try {
      const entries = await onBill({
        split,
        billable,
        ...(parsedHours !== null ? { hours: parsedHours } : {}),
      });
      setCreated(entries);
      // The sheet stays open, so the "already billed" warning has to catch up
      // with what was just written.
      refreshBilled();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not create the time entries. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="Create time entries"
      onClose={onClose}
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Close" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              <Button
                label="Create"
                loading={saving}
                // Submit guard only: the server has nothing to bill without a
                // task. Every field above stays editable regardless.
                disabled={tracker.tasks.length === 0}
                onPress={handleBill}
              />
            </View>
          </View>
        </>
      }
    >
      <Text className="text-sm text-slate-400">
        {tracker.tasks.length === 0
          ? 'This block has no tasks yet, so there is nothing to bill. Add one first.'
          : `${tracker.tasks.length} task${tracker.tasks.length === 1 ? '' : 's'} in this block.`}
      </Text>

      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          How should the hours land?
        </Text>
        {SPLITS.map(([value, label, detail]) => (
          <Pressable
            key={value}
            onPress={() => setSplit(value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: split === value }}
            className={`flex-row items-start gap-3 rounded-lg border px-3 py-3 ${
              split === value
                ? 'border-violet-500/60 bg-violet-500/10'
                : 'border-slate-700 bg-slate-950 active:bg-slate-800'
            }`}
          >
            <Text className={`text-base ${split === value ? 'text-violet-400' : 'text-slate-600'}`}>
              {split === value ? '◉' : '○'}
            </Text>
            <View className="flex-1">
              <Text className="text-sm text-slate-100">{label}</Text>
              <Text className="text-xs text-slate-500">{detail}</Text>
            </View>
          </Pressable>
        ))}
      </View>

      <NumberField
        label="Hours"
        value={hours}
        onChangeText={setHours}
        suffix="h"
        warning={hoursWarning}
        hint={
          running
            ? "Pre-filled from the tracker's span when this sheet opened; the tracker is still running, so it keeps counting past this number. Change it freely."
            : "Pre-filled from the tracker's span. Change it freely."
        }
      />

      <Pressable
        onPress={() => setBillable((prev) => !prev)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: billable }}
        className="flex-row items-center gap-3 py-1"
      >
        <Text className={`text-base ${billable ? 'text-violet-400' : 'text-slate-600'}`}>
          {billable ? '☑' : '☐'}
        </Text>
        <Text className="text-sm text-slate-100">Billable</Text>
      </Pressable>

      {alreadyBilled > 0 ? (
        <Text className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          {remaining === 0
            ? 'Every task on this tracker already has a time entry from it. Creating again makes nothing new — add a task first, or edit the existing entries on the Time Entries tab.'
            : `${alreadyBilled} of ${tracker.tasks.length} task${
                tracker.tasks.length === 1 ? '' : 's'
              } ${alreadyBilled === 1 ? 'already has a time entry' : 'already have time entries'}. ${
                remaining === 1
                  ? 'The hours you enter go entirely to the 1 remaining task — set them to just that share.'
                  : split === 'even'
                    ? `The hours you enter are split across only the ${remaining} remaining tasks — set them to just those tasks' share.`
                    : `Each of the ${remaining} remaining tasks is billed the full hours you enter — set them to just that share.`
              }`}
        </Text>
      ) : null}

      {created !== null ? (
        created.length > 0 ? (
          <Text className="rounded-lg border border-green-400/20 bg-green-400/10 px-3 py-2 text-xs text-green-400">
            Created {created.length} time {created.length === 1 ? 'entry' : 'entries'}. They are on
            the Time Entries tab, where the hours and dates stay editable.
          </Text>
        ) : (
          <Text className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-400">
            Nothing new was created — every task on this tracker already had a time entry from it.
            That is a normal outcome, not a failure.
          </Text>
        )
      ) : null}

      <Text className="text-xs text-slate-500">
        A starting point. Hours and dates stay editable on the Time Entries tab afterwards.
      </Text>
    </Sheet>
  );
}
