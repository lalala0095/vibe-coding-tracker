// Log or edit one time entry. The same form does both.
//
// ── What this form does NOT do ───────────────────────────────────────────────
//
// It never derives hours from the start and end times. The web form prefills
// the hours box from the timer as you edit; here the only hours figure shown is
// the one the **server** resolved (`duration_minutes` and `effective_hours`,
// displayed verbatim as context). Anything else would be a second, phone-local
// implementation of a number the server already owns — the thing
// `src/lib/hours.ts` exists to say we do not do.
//
// ── No locking (CLAUDE.md) ───────────────────────────────────────────────────
//
// Nothing here is ever read-only: not the hours of an entry already billed on an
// invoice, not the dates, not the billable switch. Surprising values get a
// `warning`; the save button's `loading` state is a double-submit guard and the
// only disabled thing on screen.
//
// ── Clearing conventions ─────────────────────────────────────────────────────
//
// The form emits plain values. The screen maps them onto the two wire
// conventions from `MyTrackerFormat.md`: string fields (`end_time`, `notes`)
// clear with the literal string `"null"`, the nullable numeric field (`hours`)
// clears with a real JSON `null`. `null` here means "cleared" for all three;
// which of the two conventions carries it is the screen's business, not the
// form's.

import { useMemo, useState } from 'react';
import { Modal, Pressable, Switch, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import {
  Button,
  Card,
  DateTimeField,
  ErrorNote,
  NumberField,
  Screen,
  Select,
  TextField,
  parseNumberInput,
  sanitiseNumberInput,
  type SelectOption,
} from '@/components';
import { formatHoursLabel } from '@/lib/hours';
import { nowSgt } from '@/lib/sgt';
import { theme } from '@/theme';
import type { Task, TimeEntry } from '@/types';
import { claimingInvoices } from './grouping';

/** Plain values. `null` means "cleared" — see the header. */
export interface EntryFormValues {
  task_id: string;
  start_time: string;
  end_time: string | null;
  /** A manual override. `null` falls back to the timer. `0` is a real value. */
  hours: number | null;
  billable: boolean;
  notes: string | null;
}

export interface EntryFormProps {
  /** The entry being edited, or `null` to log a new one. */
  entry: TimeEntry | null;
  /** Tasks offered in the picker. */
  tasks: Task[];
  /** Note under the task picker when the list is narrowed by the filters. */
  taskHint?: string;
  /** Throwing surfaces the message in the form and keeps it open. */
  onSubmit: (values: EntryFormValues) => Promise<void>;
  onCancel: () => void;
}

interface FieldErrors {
  task?: string;
  start?: string;
  hours?: string;
}

export default function EntryForm({ entry, tasks, taskHint, onSubmit, onCancel }: EntryFormProps) {
  const [taskId, setTaskId] = useState<string | null>(entry?.task_id ?? null);
  const [start, setStart] = useState<string | null>(entry?.start_time ?? nowSgt());
  const [end, setEnd] = useState<string | null>(entry?.end_time ?? null);
  // Held as text, not a number: "1." and "" are states a number cannot hold,
  // and an empty box is exactly what "no override" looks like.
  const [hours, setHours] = useState(entry?.hours != null ? String(entry.hours) : '');
  const [billable, setBillable] = useState(entry?.billable ?? true);
  const [notes, setNotes] = useState(entry?.notes ?? '');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const invoices = entry ? claimingInvoices(entry) : [];

  const taskOptions: SelectOption[] = useMemo(() => {
    const options = tasks.map((task) => ({
      label: task.title,
      value: task.id,
      sublabel: `${task.client_name} / ${task.project_name}`,
    }));

    // The entry's own task must always be selectable, even if the loaded list
    // does not contain it — otherwise opening the editor would silently blank
    // the task and saving would move the entry somewhere else.
    if (entry && !options.some((option) => option.value === entry.task_id)) {
      options.unshift({
        label: entry.task_title,
        value: entry.task_id,
        sublabel: `${entry.client_name} / ${entry.project_name}`,
      });
    }

    return options;
  }, [tasks, entry]);

  const running = end === null;
  const endsBeforeStart = start !== null && end !== null && end < start;
  const overriding = hours.trim() !== '';

  // The server's own figures, shown so the override has something visible to
  // diverge from. Rendered as returned — no division, no re-rounding.
  const serverContext = entry
    ? entry.duration_minutes !== null
      ? `Server: ${entry.duration_minutes} min recorded, billing ${formatHoursLabel(entry.effective_hours)}.`
      : `Server: no duration recorded yet, billing ${formatHoursLabel(entry.effective_hours)}.`
    : null;

  const hoursHint = [serverContext, 'Leave empty to use the start and end times.']
    .filter(Boolean)
    .join(' ');

  // A negative override is unusual, not forbidden. `sumHours` subtracts it as
  // given rather than clamping, for the same reason the server does not clamp an
  // over-large discount: a total that quietly disagrees with the rows above it
  // hides a real discrepancy. So this says what will happen and lets it happen.
  const negative = overriding && (parseNumberInput(hours.trim()) ?? 0) < 0;

  const hoursWarning = negative
    ? 'Negative hours will subtract from the day and overall totals.'
    : overriding
      ? 'Manual override — the recorded duration is ignored for this entry.'
      : undefined;

  const handleSubmit = async () => {
    const next: FieldErrors = {};

    if (!taskId) next.task = 'Choose the task these hours belong to.';
    if (!start) next.start = 'A start time is required.';

    // Checked before parsing, because an empty box and a 0 mean different
    // things: empty falls back to the timer, 0 is an override of zero hours.
    const raw = hours.trim();
    let hoursValue: number | null = null;
    if (raw !== '') {
      hoursValue = parseNumberInput(raw);
      if (hoursValue === null) {
        next.hours = 'Enter a number, or leave it empty to use the timer.';
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0 || !taskId || !start) return;

    setSubmitError('');
    setSubmitting(true);
    try {
      await onSubmit({
        task_id: taskId,
        start_time: start,
        end_time: end,
        // Sent exactly as typed. The server owns rounding; rounding here would
        // be this app quietly deciding a billable number.
        hours: hoursValue,
        billable,
        notes: notes.trim() ? notes.trim() : null,
      });
    } catch (e: unknown) {
      setSubmitError(apiErrorMessage(e, 'Could not save this time entry.'));
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      {/*
        `Screen` already owns the page background, the safe area, the scroll
        body and the pinned header/footer slots, so the modal reuses it rather
        than growing a second layout of its own.
      */}
      <Screen
        keyboardAvoiding
        header={
          <View className="flex-row items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <Text className="text-base font-semibold text-slate-100">
              {entry ? 'Edit time entry' : 'Log time'}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
              <Text className="text-sm font-medium text-slate-400">Cancel</Text>
            </Pressable>
          </View>
        }
        footer={
          <View className="border-t border-slate-800 px-4 py-3">
            <Button
              label={entry ? 'Save changes' : 'Log time'}
              onPress={handleSubmit}
              loading={submitting}
              testID="entry-form-submit"
            />
          </View>
        }
      >
        {invoices.length > 0 ? (
          <Card className="border-amber-500/30 bg-amber-500/10">
            <Text className="text-xs leading-relaxed text-amber-300">
              These hours are billed on {invoices.join(', ')}. Everything below stays editable — the
              invoice keeps the totals it was saved with, and will not update by itself.
            </Text>
          </Card>
        ) : null}

        <Select
          label="Task"
          value={taskId}
          onChange={setTaskId}
          options={taskOptions}
          placeholder="Choose a task…"
          title="Task"
          emptyLabel="No tasks yet. Create one under Tasks first."
          error={errors.task}
          hint={taskHint}
        />

        <DateTimeField
          label="Start"
          value={start}
          onChange={setStart}
          error={errors.start}
        />

        <DateTimeField
          label="End"
          value={end}
          onChange={setEnd}
          clearable
          placeholder="Still running"
          warning={
            endsBeforeStart
              ? 'This ends before it starts. Saved as entered — nothing is corrected for you.'
              : undefined
          }
          hint={running ? 'No end time: this entry counts as still running.' : undefined}
        />

        <NumberField
          label="Hours"
          value={hours}
          onChangeText={(value) => setHours(sanitiseNumberInput(value))}
          placeholder="From timer"
          suffix="h"
          error={errors.hours}
          warning={hoursWarning}
          hint={hoursHint}
        />

        <Card className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-base text-slate-100">Billable</Text>
            <Text className="mt-0.5 text-xs text-slate-500">
              Non-billable time still shows in these totals; no invoice picks it up.
            </Text>
          </View>
          <Switch
            value={billable}
            onValueChange={setBillable}
            trackColor={{ false: theme.borderStrong, true: theme.accent }}
            thumbColor={theme.text}
            testID="entry-form-billable"
          />
        </Card>

        <TextField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="What did you work on?"
          multiline
          numberOfLines={5}
        />

        {submitError ? <ErrorNote message={submitError} /> : null}
      </Screen>
    </Modal>
  );
}
