// The label + notes chrome shared by every field, so the four of them cannot
// drift apart.
//
// ── Why there are three note slots and no `disabled` ──────────────────────────
// CLAUDE.md: *"Timer-derived values are defaults, never constraints. Warn
// visually; never block the edit."* So a field has no read-only path — not on a
// running tracker, not on an already-invoiced time entry. When something about
// a value is worth flagging, the caller passes a note and the user reads it and
// decides:
//
//   error   red    — the value is wrong / the save failed
//   warning amber  — the value is surprising but allowed ("already invoiced")
//   hint    slate  — neutral help text
//
// None of the three changes what can be typed.

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

export interface FieldNotes {
  /** Red. The value is wrong, or the last save of it failed. */
  error?: string;
  /** Amber. Allowed, but worth seeing — this never blocks the edit. */
  warning?: string;
  /** Slate. Neutral help text. */
  hint?: string;
}

export interface FieldFrameProps extends FieldNotes {
  label?: string;
  /** Rendered at the right end of the label row — a "Clear" affordance. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function FieldFrame({
  label,
  action,
  error,
  warning,
  hint,
  children,
  className = '',
}: FieldFrameProps) {
  return (
    <View className={`gap-1.5 ${className}`}>
      {(label || action) && (
        <View className="flex-row items-center justify-between">
          {label ? (
            <Text className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {label}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      )}

      {children}

      {error ? <Text className="text-xs text-red-400">{error}</Text> : null}
      {warning ? <Text className="text-xs text-amber-400">{warning}</Text> : null}
      {hint ? <Text className="text-xs text-slate-500">{hint}</Text> : null}
    </View>
  );
}

/** The input border, red when the field is carrying an error. */
export function fieldBorder(error?: string): string {
  return error ? 'border-red-500/70' : 'border-slate-700';
}
