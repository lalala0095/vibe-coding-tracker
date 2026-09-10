// Creating and editing a work block.
//
// The form emits plain values — `null` meaning "no end time" and "no notes" —
// and `app/trackers.tsx` turns those into the wire payload. That split is the
// one `app/clients.tsx` already uses, and it exists because the *clearing*
// convention is a wire detail: it differs between create and update, and
// keeping it in one place beats spreading it across a form.
//
// Nothing here is ever disabled or read-only (CLAUDE.md § no locking). A
// tracker that ends before it starts, a start time in the future, an already
// invoiced block — each is warned about in words and saved as entered. The only
// `disabled` in the file is on the submit button, guarding a double tap and the
// two fields the server requires.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import { Button, DateTimeField, TextField } from '@/components';
import { nowSgt, parseSgt } from '@/lib/sgt';
import { renderTrackerName } from '@/lib/trackerName';
import { isFuture, nameMoment } from '@/screens/now/trackerTime';
import Sheet from '@/screens/now/Sheet';
import type { Tracker, TrackerSettings } from '@/types';

/** `null` means the field is empty — cleared on save, or simply never set. */
export interface TrackerFormValues {
  title: string;
  start_time: string;
  end_time: string | null;
  notes: string | null;
}

export interface TrackerFormSheetProps {
  open: boolean;
  /** `null` creates; a tracker edits it. */
  tracker: Tracker | null;
  /**
   * Best-effort, exactly as on the Now screen: `null` when the settings call
   * failed or has not landed, which costs the pre-filled title and nothing
   * else. A settings hiccup must never stand between the owner and a tracker.
   */
  settings: TrackerSettings | null;
  onSubmit: (values: TrackerFormValues) => Promise<void>;
  onClose: () => void;
}

/**
 * What the stored template renders to, or `''` when there is nothing to
 * pre-fill with — no settings, auto-naming off, or a blank template.
 *
 * The same four lines as `autoTrackerName()` in
 * `src/screens/now/StartTrackerSheet.tsx`, which does not export them. Both
 * mirror `autoTrackerName()` in `front/src/pages/TrackersPage.tsx`; the
 * template rendering itself is `lib/trackerName.ts` and is not copied.
 */
function autoTrackerName(settings: TrackerSettings | null, startTime: string): string {
  if (!settings?.auto_name_enabled) return '';
  if (!settings.auto_name_template.trim()) return '';
  return renderTrackerName(settings.auto_name_template, nameMoment(startTime));
}

export default function TrackerFormSheet({
  open,
  tracker,
  settings,
  onSubmit,
  onClose,
}: TrackerFormSheetProps) {
  const editing = tracker !== null;

  const [startTime, setStartTime] = useState<string | null>(
    () => tracker?.start_time ?? nowSgt(),
  );
  // Rendered once, from the start time the sheet opened with — there is
  // deliberately no effect tying the title to the start time, because
  // re-rendering it later would overwrite a title the user had already typed
  // (§ no locking). Editing shows the stored title untouched.
  const [title, setTitle] = useState(
    () => tracker?.title ?? autoTrackerName(settings, startTime ?? nowSgt()),
  );
  const [endTime, setEndTime] = useState<string | null>(() => tracker?.end_time ?? null);
  const [notes, setNotes] = useState(tracker?.notes ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const trimmedTitle = title.trim();
  const prefilled = !editing && autoTrackerName(settings, startTime ?? nowSgt()) !== '';

  const start = parseSgt(startTime);
  const end = parseSgt(endTime);
  const endsBeforeStart = start !== null && end !== null && end.getTime() < start.getTime();
  // Editing a stopped tracker and emptying its end time puts it back to
  // running. That is a real and useful thing to do — and surprising enough to
  // say out loud before it happens rather than after.
  const restarting = editing && tracker.end_time !== null && endTime === null;

  const endWarning = endsBeforeStart
    ? 'This block ends before it starts. Saved exactly as entered — the clock will read 00:00:00 until the times agree.'
    : restarting
      ? 'Empty means running. Saving this restarts the tracker and it starts counting again from its start time.'
      : undefined;

  async function handleSubmit() {
    if (!trimmedTitle || !startTime) return;

    setSaving(true);
    setError('');
    try {
      await onSubmit({
        title: trimmedTitle,
        start_time: startTime,
        end_time: endTime,
        notes: notes.trim() ? notes.trim() : null,
      });
      onClose();
    } catch (e) {
      setError(
        apiErrorMessage(
          e,
          editing ? 'Could not save the tracker. Try again.' : 'Could not create the tracker. Try again.',
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title={editing ? 'Edit tracker' : 'New tracker'}
      onClose={onClose}
      testID="tracker-form"
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              <Button
                label={editing ? 'Save' : 'Create'}
                loading={saving}
                // A submit guard — the server requires both. Nothing about the
                // fields themselves is locked.
                disabled={!trimmedTitle || !startTime}
                onPress={handleSubmit}
                testID="tracker-form-submit"
              />
            </View>
          </View>
        </>
      }
    >
      {editing && tracker.invoice_numbers.length > 0 ? (
        // A badge in prose, not a lock: every field below stays editable. The
        // invoice already holds its own snapshot of these figures, so nothing
        // typed here rewrites a past invoice (CLAUDE.md § Invoicing).
        <Text className="rounded-lg border border-indigo-400/20 bg-indigo-400/10 px-3 py-2 text-xs text-indigo-300">
          Already billed on {tracker.invoice_numbers.join(', ')}. Editing is allowed — those
          invoices keep the figures they were issued with.
        </Text>
      ) : null}

      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="What is this block of work?"
        autoFocus={!editing && !prefilled}
        hint={
          prefilled
            ? 'Pre-filled from your tracker-name template. Change it freely — nothing rewrites it.'
            : undefined
        }
        testID="tracker-title"
      />

      <DateTimeField
        label="Start time"
        value={startTime}
        onChange={setStartTime}
        warning={
          isFuture(startTime)
            ? 'This start time is in the future. The elapsed clock reads 00:00:00 until it passes.'
            : undefined
        }
        hint={editing ? undefined : 'Defaults to now, Singapore time. Backdate it if the work already started.'}
        testID="tracker-start"
      />

      <View className="gap-2">
        <DateTimeField
          label="End time"
          value={endTime}
          onChange={setEndTime}
          clearable
          placeholder="Still running"
          warning={endWarning}
          hint="Leave it empty and the tracker keeps running."
          testID="tracker-end"
        />
        {endTime === null ? (
          // The Now tab's Stop button in miniature, and for the same reason it
          // is written this way: `nowSgt()`, never `new Date().toISOString()`,
          // which would date a block stopped before 08:00 SGT a day early.
          <Pressable
            onPress={() => setEndTime(nowSgt())}
            hitSlop={8}
            accessibilityRole="button"
            className="self-start rounded-lg px-1 py-1 active:bg-slate-800"
          >
            <Text className="text-xs font-medium text-blue-400">Set to now</Text>
          </Pressable>
        ) : null}
      </View>

      <TextField
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        placeholder="Optional"
        multiline
        numberOfLines={3}
        hint={editing ? 'Emptying this clears the stored note.' : undefined}
        testID="tracker-notes"
      />

      {!editing ? (
        <Text className="text-xs text-slate-500">
          Tasks are added to the block after it exists — a tracker with no tasks has no time to
          bill.
        </Text>
      ) : null}
    </Sheet>
  );
}
