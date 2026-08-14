// The page shell. Every route renders exactly one of these.
//
// It owns the three things every screen would otherwise re-derive: the
// `bg-slate-950` page background, the safe-area insets, and pull-to-refresh.

import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView, type Edges } from 'react-native-safe-area-context';

import { theme } from '@/theme';

export interface ScreenProps {
  children: ReactNode;
  /**
   * `true` (the default) puts the body in a `ScrollView`. Pass `false` for a
   * screen that owns its own scrolling — a `FlatList`, typically, which must
   * not be nested inside a ScrollView.
   */
  scroll?: boolean;
  /** Pull-to-refresh. Both are required together; neither alone does anything. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Pinned above the body, outside the scroll area — a title row, filters. */
  header?: ReactNode;
  /** Pinned below the body — a primary action bar. */
  footer?: ReactNode;
  /** Classes on the body container. Defaults to `px-4 py-4 gap-4`. */
  className?: string;
  /** Which edges get inset padding. Defaults to top + bottom. */
  edges?: Edges;
  /** Lifts the body above the keyboard. Off by default; forms want it on. */
  keyboardAvoiding?: boolean;
  testID?: string;
}

const DEFAULT_BODY = 'px-4 py-4 gap-4';

export default function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  header,
  footer,
  className = DEFAULT_BODY,
  edges = ['top', 'bottom'],
  keyboardAvoiding = false,
  testID,
}: ScreenProps) {
  const refreshControl =
    onRefresh !== undefined ? (
      <RefreshControl
        refreshing={refreshing ?? false}
        onRefresh={onRefresh}
        tintColor={theme.refreshTint}
        colors={[theme.refreshTint]}
        progressBackgroundColor={theme.surface}
      />
    ) : undefined;

  const body = scroll ? (
    <ScrollView
      className="flex-1"
      // flexGrow keeps a short page pullable and lets an EmptyState centre.
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
    >
      <View className={`flex-1 ${className}`}>{children}</View>
    </ScrollView>
  ) : (
    <View className={`flex-1 ${className}`}>{children}</View>
  );

  const content = (
    <>
      {header}
      {body}
      {footer}
    </>
  );

  return (
    <SafeAreaView className="flex-1 bg-slate-950" edges={edges} testID={testID}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          className="flex-1"
          // Android resizes the window itself (`adjustResize`); adding padding
          // on top of that double-counts the keyboard.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}
