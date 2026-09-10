// A decimal field, in practice always hours.
//
// ── The value is a string, on purpose ─────────────────────────────────────────
// Holding a `number` and reformatting on every keystroke fights the typist:
// "1." is not a number, "1.50" round-trips to "1.5", and an empty box becomes
// "0". The caller keeps the raw text and converts once, on save, with
// `parseNumberInput`.
//
// ── No locking ────────────────────────────────────────────────────────────────
// There is no `editable` / `readOnly` prop here and there must never be one:
// hours are the exact field CLAUDE.md's rule is about. A tracker-derived figure
// is a default, and an entry already pulled into an invoice is still editable —
// pass `warning` and let the user decide.
//
// The keypad filter below drops characters that are not part of a decimal
// number. That is keyboard hygiene, not a lock: every value the field can hold
// remains reachable, including a negative one.

import { Text, TextInput, View } from 'react-native';

import { theme } from '@/theme';
import FieldFrame, { fieldBorder, type FieldNotes } from './FieldFrame';

export interface NumberFieldProps extends FieldNotes {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Rendered inside the field, at the right — "h". */
  suffix?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
  className?: string;
  testID?: string;
}

/**
 * Keep digits, at most one decimal point, and a single leading minus.
 *
 * Partial input survives: "", "-", "1." and ".5" all pass through unchanged so
 * the field never rewrites what is being typed mid-keystroke.
 */
export function sanitiseNumberInput(raw: string): string {
  const negative = raw.trimStart().startsWith('-');
  const digitsAndDots = raw.replace(/[^0-9.]/g, '');

  const firstDot = digitsAndDots.indexOf('.');
  const body =
    firstDot === -1
      ? digitsAndDots
      : digitsAndDots.slice(0, firstDot + 1) + digitsAndDots.slice(firstDot + 1).replace(/\./g, '');

  return negative ? `-${body}` : body;
}

/**
 * The text as a number, or `null` when the box is empty or still half-typed.
 *
 * Nothing is clamped or rounded — the server owns every derived value, and a
 * figure the user typed is sent as typed.
 */
export function parseNumberInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function NumberField({
  label,
  value,
  onChangeText,
  placeholder = '0.00',
  suffix,
  autoFocus = false,
  onBlur,
  error,
  warning,
  hint,
  className,
  testID,
}: NumberFieldProps) {
  return (
    <FieldFrame label={label} error={error} warning={warning} hint={hint} className={className}>
      <View className={`flex-row items-center rounded-lg border bg-slate-950 ${fieldBorder(error)}`}>
        <TextInput
          value={value}
          onChangeText={(next) => onChangeText(sanitiseNumberInput(next))}
          placeholder={placeholder}
          placeholderTextColor={theme.textFaint}
          selectionColor={theme.accent}
          keyboardType="decimal-pad"
          inputMode="decimal"
          autoFocus={autoFocus}
          onBlur={onBlur}
          className="flex-1 px-3 py-2.5 text-base text-slate-100"
          testID={testID}
        />
        {suffix ? <Text className="pr-3 text-sm text-slate-500">{suffix}</Text> : null}
      </View>
    </FieldFrame>
  );
}
