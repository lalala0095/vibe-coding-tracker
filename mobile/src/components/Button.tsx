// The one button.
//
// ── On `disabled` ─────────────────────────────────────────────────────────────
// CLAUDE.md's no-locking rule governs *values* — hours, rates, dates, amounts —
// and the fields that hold them. It does not govern actions. A button that
// disables itself while its request is in flight is a double-submit guard, and
// a button that disables itself because nothing is selected yet is describing
// the action, not locking a value.
//
// What is never acceptable is reaching for `disabled` to stop someone editing a
// number. If that is the impulse, the fix is a `warning` on the field.

import { ActivityIndicator, Pressable, Text } from 'react-native';

import { theme } from '@/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner beside the label and blocks a second tap. */
  loading?: boolean;
  /** A submit guard, never a value lock — see the note at the top of the file. */
  disabled?: boolean;
  /** `true` stretches to the container; otherwise the button hugs its label. */
  fullWidth?: boolean;
  className?: string;
  textClassName?: string;
  testID?: string;
}

const CONTAINER: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 active:bg-blue-700 border border-blue-600',
  secondary: 'bg-slate-800 active:bg-slate-700 border border-slate-700',
  danger: 'bg-red-600 active:bg-red-700 border border-red-600',
  ghost: 'bg-transparent active:bg-slate-800 border border-transparent',
};

const LABEL: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-slate-100',
  danger: 'text-white',
  ghost: 'text-slate-400',
};

const SPINNER: Record<ButtonVariant, string> = {
  primary: theme.spinnerOnPrimary,
  secondary: theme.text,
  danger: theme.spinnerOnPrimary,
  ghost: theme.textMuted,
};

const SIZE: Record<ButtonSize, string> = {
  md: 'px-4 py-2.5 rounded-lg',
  lg: 'px-5 py-4 rounded-xl',
};

const SIZE_LABEL: Record<ButtonSize, string> = {
  md: 'text-sm',
  lg: 'text-base',
};

export default function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = true,
  className = '',
  textClassName = '',
  testID,
}: ButtonProps) {
  const inert = loading || disabled;

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: loading }}
      className={[
        'flex-row items-center justify-center gap-2',
        SIZE[size],
        CONTAINER[variant],
        fullWidth ? 'w-full' : 'self-start',
        inert ? 'opacity-50' : '',
        className,
      ].join(' ')}
      testID={testID}
    >
      {loading && <ActivityIndicator size="small" color={SPINNER[variant]} />}
      <Text
        className={`font-medium ${SIZE_LABEL[size]} ${LABEL[variant]} ${textClassName}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
