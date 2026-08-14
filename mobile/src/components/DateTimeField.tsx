// A date + time control that speaks the wire format, and only the wire format.
//
// ── The rule this component exists to keep ────────────────────────────────────
//
// `value` in and `onChange` out are both `2026-08-14T21:05:33+08:00` — Singapore
// wall-clock with an explicit `+08:00`, exactly what `_now_sgt()` writes on the
// server and what a `datetime-local` box writes on the web. **Nothing here calls
// `.toISOString()`**, which would emit UTC with a `Z` and, on a phone between
// midnight and 08:00 SGT, silently record the previous day. See the header of
// `src/lib/sgt.ts`; that comment is the reason this file is written the way it
// is.
//
// ── Why a plain local `Date` is handed to the picker ──────────────────────────
//
// `@react-native-community/datetimepicker` shows, and returns, the *device's*
// local wall-clock reading of the `Date` it is given. So the bridge in both
// directions is the calendar fields, never the instant:
//
//   store → picker   `sgtFields()` gives the Singapore fields; they are placed
//                    into a Date via the local constructor, so the dialog shows
//                    those exact numbers whatever timezone the phone is in.
//   picker → store   the local getters read those same numbers back out, and
//                    `fromSgtFields()` stamps `+08:00` on them.
//
// The one place this is imperfect is a phone in a DST zone whose local clock
// skips the chosen hour; that hour cannot be constructed locally and the dialog
// shifts by one. There is no such hour in Singapore, and the alternative —
// `Intl` with a `timeZone` option — is the dependency `sgt.ts` deliberately
// avoids on Hermes.
//
// ── No locking ────────────────────────────────────────────────────────────────
//
// No `editable`/`disabled` prop, and no `minimumDate`/`maximumDate` either: a
// date range is exactly the kind of constraint CLAUDE.md rules out. A start
// after its end, or an entry dated in the future, is the user's call — pass
// `warning` and say so.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import {
  formatSgtDate,
  formatSgtDateTime,
  formatSgtTime,
  fromSgtFields,
  parseSgt,
  sgtFields,
  type SgtFields,
} from '@/lib/sgt';
import FieldFrame, { fieldBorder, type FieldNotes } from './FieldFrame';

export type DateTimeMode = 'datetime' | 'date';
export type DateTimeLayout = 'split' | 'single';

export interface DateTimeFieldProps extends FieldNotes {
  label?: string;
  /** A wire timestamp (`2026-08-14T21:05:33+08:00`) or `null` for unset. */
  value: string | null;
  /** Emits the same wire format, or `null` when cleared. */
  onChange: (value: string | null) => void;
  /** `'date'` hides the time control and keeps the stored time untouched. */
  mode?: DateTimeMode;
  /**
   * `'split'` (default) shows separate date and time targets, so the time can
   * be corrected without walking through a calendar. `'single'` shows one
   * target that chains date → time; use it in a tight row.
   */
  layout?: DateTimeLayout;
  /** Adds a "Clear" action that emits `null`. */
  clearable?: boolean;
  /** Shown when `value` is null. */
  placeholder?: string;
  className?: string;
  testID?: string;
}

/**
 * The Singapore fields a pick starts from: the current value, or now when
 * there is none. A date-only field with no value starts at midnight rather
 * than at whatever o'clock it happens to be.
 */
function baseFields(value: string | null, mode: DateTimeMode): SgtFields {
  const parsed = parseSgt(value);
  if (parsed) return sgtFields(parsed);

  const now = sgtFields(new Date());
  return mode === 'date' ? { ...now, hour: 0, minute: 0, second: 0 } : now;
}

/** Singapore fields → the local `Date` the dialog should display. */
function toPickerDate(fields: SgtFields): Date {
  return new Date(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
}

export default function DateTimeField({
  label,
  value,
  onChange,
  mode = 'datetime',
  layout = 'split',
  clearable = false,
  placeholder = 'Not set',
  error,
  warning,
  hint,
  className,
  testID,
}: DateTimeFieldProps) {
  const [picking, setPicking] = useState<'date' | 'time' | null>(null);
  // Holds the half-finished value while `layout="single"` chains date → time,
  // so the time dialog opens on the day that was just chosen.
  const [draft, setDraft] = useState<string | null>(null);

  const chains = layout === 'single' && mode === 'datetime';
  const working = draft ?? value;

  const openDate = () => {
    setDraft(null);
    setPicking('date');
  };

  const openTime = () => {
    setDraft(null);
    setPicking('time');
  };

  const handleDate = (picked: Date) => {
    const base = baseFields(working, mode);
    // Seconds are carried through untouched here: only the calendar day moved.
    const next = fromSgtFields({
      ...base,
      year: picked.getFullYear(),
      month: picked.getMonth() + 1,
      day: picked.getDate(),
    });

    if (chains) {
      setDraft(next);
      setPicking('time');
      return;
    }

    setPicking(null);
    onChange(next);
  };

  const handleTime = (picked: Date) => {
    const base = baseFields(working, mode);
    // Seconds reset to 0: the user just set the clock, and the web's
    // `datetime-local` inputs write `:00` for the same reason.
    const next = fromSgtFields({
      ...base,
      hour: picked.getHours(),
      minute: picked.getMinutes(),
      second: 0,
    });

    setPicking(null);
    setDraft(null);
    onChange(next);
  };

  const dismiss = () => {
    setPicking(null);
    setDraft(null);
  };

  const target = (label_: string, filled: boolean, onPress: () => void, extra = '') => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`rounded-lg border bg-slate-950 px-3 py-2.5 active:bg-slate-900 ${fieldBorder(error)} ${extra}`}
    >
      <Text className={`text-base ${filled ? 'text-slate-100' : 'text-slate-500'}`} numberOfLines={1}>
        {label_}
      </Text>
    </Pressable>
  );

  const filled = value !== null && parseSgt(value) !== null;

  return (
    <FieldFrame
      label={label}
      error={error}
      warning={warning}
      hint={hint}
      className={className}
      action={
        clearable && value !== null ? (
          <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityRole="button">
            <Text className="text-xs font-medium text-slate-400">Clear</Text>
          </Pressable>
        ) : undefined
      }
    >
      <View className="flex-row gap-2" testID={testID}>
        {layout === 'single' || mode === 'date'
          ? target(
              filled
                ? mode === 'date'
                  ? formatSgtDate(value)
                  : formatSgtDateTime(value)
                : placeholder,
              filled,
              openDate,
              'flex-1',
            )
          : (
            <>
              {target(filled ? formatSgtDate(value) : placeholder, filled, openDate, 'flex-1')}
              {target(filled ? formatSgtTime(value) : '--:--', filled, openTime, 'w-24')}
            </>
          )}
      </View>

      {picking !== null && (
        <DateTimePicker
          value={toPickerDate(baseFields(working, mode))}
          mode={picking}
          display="default"
          is24Hour
          onValueChange={(_event, picked) => {
            if (picking === 'date') handleDate(picked);
            else handleTime(picked);
          }}
          onDismiss={dismiss}
        />
      )}
    </FieldFrame>
  );
}
