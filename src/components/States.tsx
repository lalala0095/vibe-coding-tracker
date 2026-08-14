// The three states every list screen has besides "here is the data": loading,
// failed, and empty. One file because they are always considered together —
// a screen that renders two of the three has a hole in it.

import { ActivityIndicator, Text, View } from 'react-native';

import { theme } from '@/theme';
import Button from './Button';

export interface LoadingBlockProps {
  /** Optional line under the spinner — "Loading time entries…". */
  label?: string;
  className?: string;
  testID?: string;
}

export function LoadingBlock({ label, className = '', testID }: LoadingBlockProps) {
  return (
    <View className={`items-center justify-center gap-3 py-10 ${className}`} testID={testID}>
      <ActivityIndicator size="large" color={theme.spinner} />
      {label ? <Text className="text-sm text-slate-500">{label}</Text> : null}
    </View>
  );
}

export interface ErrorNoteProps {
  /** Already a sentence for the user — run it through `apiErrorMessage` first. */
  message: string;
  /** Adds a Retry button. Omit it when there is nothing sensible to retry. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  testID?: string;
}

export function ErrorNote({
  message,
  onRetry,
  retryLabel = 'Try again',
  className = '',
  testID,
}: ErrorNoteProps) {
  return (
    <View
      className={`gap-3 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 ${className}`}
      testID={testID}
    >
      <Text className="text-sm text-red-400">{message}</Text>
      {onRetry ? (
        <Button label={retryLabel} onPress={onRetry} variant="secondary" fullWidth={false} />
      ) : null}
    </View>
  );
}

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** Both are needed for the button to appear. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  testID?: string;
}

export function EmptyState({
  title,
  subtitle,
  actionLabel,
  onAction,
  className = '',
  testID,
}: EmptyStateProps) {
  return (
    <View className={`items-center justify-center gap-2 px-6 py-12 ${className}`} testID={testID}>
      <Text className="text-center text-base font-medium text-slate-300">{title}</Text>
      {subtitle ? (
        <Text className="text-center text-sm leading-relaxed text-slate-500">{subtitle}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <View className="mt-3">
          <Button label={actionLabel} onPress={onAction} fullWidth={false} />
        </View>
      ) : null}
    </View>
  );
}
