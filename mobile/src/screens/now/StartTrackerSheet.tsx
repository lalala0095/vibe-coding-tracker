// Starting a work block.
//
// Mounted only while open (`{open && <StartTrackerSheet …/>}` in the screen), so
// "rendered once, at mount" means "rendered once per opening" — which is what
// makes the auto-name reflect the moment you actually opened it.

import { useState } from 'react';
import { Text, View } from 'react-native';

import { apiErrorMessage } from '@/api';
import { Button, DateTimeField, TextField } from '@/components';
import { nowSgt } from '@/lib/sgt';
import { renderTrackerName } from '@/lib/trackerName';
import type { CreateTrackerPayload, TrackerSettings } from '@/types';

import Sheet from './Sheet';
import { isFuture, nameMoment } from './trackerTime';

export interface StartTrackerSheetProps {
  open: boolean;
  /**
   * Best-effort. `null` when the settings call failed or has not landed — which
   * costs the pre-filled name and nothing else. A settings hiccup must never
   * stand between the owner and a running timer.
   */
  settings: TrackerSettings | null;
  onClose: () => void;
  onStart: (payload: CreateTrackerPayload) => Promise<void>;
}

/**
 * What the stored template renders to, or `''` when there is nothing to
 * pre-fill with — no settings, auto-naming switched off, or a blank template.
 * Mirrors `autoTrackerName()` in `front/src/pages/TrackersPage.tsx`.
 */
function autoTrackerName(settings: TrackerSettings | null, startTime: string): string {
  if (!settings?.auto_name_enabled) return '';
  if (!settings.auto_name_template.trim()) return '';
  return renderTrackerName(settings.auto_name_template, nameMoment(startTime));
}

export default function StartTrackerSheet({
  open,
  settings,
  onClose,
  onStart,
}: StartTrackerSheetProps) {
  const [startTime, setStartTime] = useState<string | null>(() => nowSgt());
  // Rendered once, from the start time the sheet opened with. There is
  // deliberately no effect tying the title to the start time: re-rendering it
  // when the start time changes would overwrite a title the user had already
  // typed (§ no locking).
  const [title, setTitle] = useState(() => autoTrackerName(settings, startTime ?? nowSgt()));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const trimmedTitle = title.trim();
  const prefilled = autoTrackerName(settings, startTime ?? nowSgt());

  async function handleStart() {
    if (!trimmedTitle || !startTime) return;

    setSaving(true);
    setError('');
    try {
      await onStart({
        title: trimmedTitle,
        start_time: startTime,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not start the tracker. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="Start a tracker"
      onClose={onClose}
      footer={
        <>
          {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Cancel" variant="secondary" onPress={onClose} />
            </View>
            <View className="flex-1">
              <Button
                label="Start"
                loading={saving}
                // A submit guard — the server requires a title and a start
                // time. Nothing about the fields themselves is locked.
                disabled={!trimmedTitle || !startTime}
                onPress={handleStart}
              />
            </View>
          </View>
        </>
      }
    >
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="What is this block of work?"
        autoFocus={!prefilled}
        hint={
          prefilled
            ? 'Pre-filled from your tracker-name template. Change it freely — nothing rewrites it.'
            : undefined
        }
      />

      <DateTimeField
        label="Start time"
        value={startTime}
        onChange={setStartTime}
        warning={
          isFuture(startTime)
            ? 'This start time is in the future. The elapsed clock will read 00:00:00 until it passes.'
            : undefined
        }
        hint="Defaults to now, Singapore time. Backdate it if the work already started."
      />

      <TextField
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        placeholder="Optional"
        multiline
        numberOfLines={3}
      />

      <Text className="text-xs text-slate-500">
        Tasks are added to the block after it starts — a tracker with no tasks has no time to bill.
      </Text>
    </Sheet>
  );
}
