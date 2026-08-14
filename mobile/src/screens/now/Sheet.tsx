// The bottom-sheet shell the three Now sheets share.
//
// `Select` and `ConfirmSheet` in the UI kit each own their own modal, and Task C
// deliberately did not factor a shell out of them — they differ too much. These
// three do not: all of them are "a titled sheet with a scrolling body and a
// pinned action row", so the shell lives here rather than three times over.
//
// Scoped to `src/screens/now/` on purpose. If a second screen wants it, it gets
// promoted into `src/components/` by whoever owns that directory.

import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned below the body — the confirm / cancel row. */
  footer?: ReactNode;
  testID?: string;
}

export default function Sheet({ open, title, onClose, children, footer, testID }: SheetProps) {
  // Percentage max-heights need the parent to have a resolved height, which is
  // exactly the thing that is hard to guarantee inside a Modal. The arithmetic
  // version cannot fail — same reasoning as `Select`.
  const { height } = useWindowDimensions();

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        {/* Swallows the press so a tap inside the sheet does not close it. */}
        <Pressable
          onPress={() => {}}
          className="w-full rounded-t-2xl border-t border-slate-800 bg-slate-900"
          style={{ maxHeight: height * 0.9 }}
          testID={testID}
        >
          <View className="flex-row items-center justify-between border-b border-slate-800 px-4 py-3">
            <Text className="flex-1 pr-2 text-base font-semibold text-slate-100" numberOfLines={1}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
              <Text className="px-1 text-lg text-slate-400">✕</Text>
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" className="px-4">
            <View className="gap-4 py-4">{children}</View>
          </ScrollView>

          {footer ? (
            <View className="gap-3 border-t border-slate-800 px-4 pb-6 pt-3">{footer}</View>
          ) : (
            <View className="pb-4" />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
